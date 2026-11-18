import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0',8], ['10.0.0.0',8], ['100.64.0.0',10], ['127.0.0.0',8],
  ['169.254.0.0',16], ['172.16.0.0',12], ['192.0.0.0',24], ['192.0.2.0',24],
  ['192.88.99.0',24], ['192.168.0.0',16], ['198.18.0.0',15], ['198.51.100.0',24],
  ['203.0.113.0',24], ['224.0.0.0',4], ['240.0.0.0',4],
] as const) blocked.addSubnet(address,prefix,'ipv4')
blocked.addAddress('168.63.129.16','ipv4') // Azure host/metadata virtual address.
const globalV6 = new BlockList()
globalV6.addSubnet('2000::',3,'ipv6')
for (const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const) {
  blocked.addSubnet(address,prefix,'ipv6')
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address,'ipv4')
  return family === 6 && globalV6.check(address,'ipv6') && !blocked.check(address,'ipv6')
}

export async function resolvePublicUrl(input: string): Promise<{ url: URL; address: string; family: number }> {
  const url = new URL(input)
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持不含凭据的 http/https URL')
  const hostname = url.hostname.replace(/^\[|\]$/g,'')
  const addresses = isIP(hostname) ? [{address:hostname,family:isIP(hostname)}] : await dns.lookup(hostname,{all:true,verbatim:true})
  if (!addresses.length || addresses.some(({address}) => !isPublicAddress(address))) throw new Error('URL 不允许访问本机、内网或保留地址')
  return {url,...addresses[0]!}
}

interface Download { status: number; headers: http.IncomingHttpHeaders; body: Buffer }
const REDIRECTS = new Set([301,302,303,307,308])

/** Resolve once per hop and pin the connection to the checked address to prevent DNS rebinding. */
export async function fetchPublicUrl(input: string): Promise<Download & {url: string}> {
  const signal = AbortSignal.timeout(20_000)
  let next = input
  for (let hop=0;hop<=5;hop+=1) {
    const target = await resolvePublicUrl(next)
    signal.throwIfAborted()
    const response = await new Promise<Download>((resolve,reject) => {
      const request = (target.url.protocol === 'https:' ? https : http).request(target.url, {
        method:'GET',headers:{'user-agent':'KnoWeave/0.1'},signal,agent:false,
        // Node uses the URL hostname for Host and TLS SNI, but this fixed lookup for the socket.
        lookup: (_hostname,options,callback) => {
          if (options.all) callback(null,[{address:target.address,family:target.family}])
          else callback(null,target.address,target.family)
        },
      }, (stream) => {
        const status=stream.statusCode ?? 502
        if (REDIRECTS.has(status)) {
          resolve({status,headers:stream.headers,body:Buffer.alloc(0)})
          stream.destroy()
          return
        }
        const buffers:Buffer[]=[]
        let size=0
        stream.on('data',(data:Buffer) => {
          size+=data.length
          if (size>32*1024*1024) stream.destroy(new Error('URL 内容超过 32 MiB'))
          else buffers.push(data)
        })
        stream.on('error',reject)
        stream.on('end',()=>resolve({status,headers:stream.headers,body:Buffer.concat(buffers)}))
      })
      request.on('error',reject)
      request.end()
    })
    if (!REDIRECTS.has(response.status)) {
      const encoding=response.headers['content-encoding']?.toLowerCase().trim()
      const options={maxOutputLength:32*1024*1024}
      if (encoding === 'gzip') response.body=gunzipSync(response.body,options)
      else if (encoding === 'deflate') response.body=inflateSync(response.body,options)
      else if (encoding === 'br') response.body=brotliDecompressSync(response.body,options)
      else if (encoding && encoding !== 'identity') throw new Error('URL 响应使用不支持的内容编码')
      return {...response,url:target.url.href}
    }
    if (!response.headers.location) throw new Error('重定向缺少 Location')
    next=new URL(response.headers.location,target.url).href
  }
  throw new Error('URL 重定向次数过多')
}
