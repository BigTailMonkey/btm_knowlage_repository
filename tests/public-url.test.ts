import assert from 'node:assert/strict'
import { test } from 'node:test'
import dns from 'node:dns/promises'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { isPublicAddress, resolvePublicUrl, fetchPublicUrl } from '../src/util/public-url.js'

test('URL ingestion accepts global unicast addresses and blocks private/reserved encodings', async () => {
  for (const address of ['8.8.8.8','93.184.216.34','2606:4700:4700::1111']) assert.equal(isPublicAddress(address),true,address)
  for (const address of ['127.0.0.1','10.1.2.3','100.100.100.200','169.254.169.254','172.16.0.1','192.168.0.1','198.18.0.1','224.0.0.1','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2001:db8::1','2002:7f00:1::']) assert.equal(isPublicAddress(address),false,address)
  for (const url of ['http://2130706433','http://0x7f000001','http://[::ffff:127.0.0.1]','http://127.0.0.1','ftp://8.8.8.8','https://user:secret@8.8.8.8']) await assert.rejects(resolvePublicUrl(url))
})

test('mixed public/private DNS answers are rejected before connecting', async (t) => {
  t.mock.method(dns,'lookup',async () => [{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}])
  await assert.rejects(resolvePublicUrl('http://mixed.example'),/内网/)
})

test('redirect destinations are checked and sockets use the validated DNS address', async (t) => {
  t.mock.method(dns,'lookup',async () => [{address:'93.184.216.34',family:4}])
  let calls=0
  t.mock.method(http,'request',((url:URL,options:http.RequestOptions,callback:(stream:http.IncomingMessage)=>void) => {
    calls+=1
    assert.equal(url.hostname,'public.example')
    assert.equal(options.agent,false)
    const lookup=options.lookup!
    lookup('public.example',{all:false},(_error,address,family) => {
      assert.equal(address,'93.184.216.34')
      assert.equal(family,4)
    })
    const request=new EventEmitter() as http.ClientRequest
    request.end=(() => {
      const stream=new PassThrough() as unknown as http.IncomingMessage
      stream.statusCode=302
      stream.headers={location:'http://127.0.0.1/internal'}
      callback(stream)
      return request
    }) as typeof request.end
    return request
  }) as typeof http.request)
  await assert.rejects(fetchPublicUrl('http://public.example/start'),/内网/)
  assert.equal(calls,1)
})
