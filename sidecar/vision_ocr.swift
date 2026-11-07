import Foundation
import Vision
import ImageIO
import CoreGraphics

func recognize(_ image: CGImage, page: Int, unit: Double) throws -> [[String: Any]] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = true
    try VNImageRequestHandler(cgImage: image).perform([request])
    return (request.results ?? []).compactMap { observation in
        guard let text = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        let width = Double(image.width) * unit
        let height = Double(image.height) * unit
        return ["text": text.string, "confidence": Double(text.confidence), "page": page,
                "bbox": [box.minX * width, (1 - box.maxY) * height, box.maxX * width, (1 - box.minY) * height]]
    }
}

let url = URL(fileURLWithPath: CommandLine.arguments[1])
var rows: [[String: Any]] = []
if url.pathExtension.lowercased() == "pdf" {
    guard let document = CGPDFDocument(url as CFURL) else { throw NSError(domain:"OCR",code:1,userInfo:[NSLocalizedDescriptionKey:"PDF无法读取"]) }
    for number in 1...max(1, document.numberOfPages) {
        guard let page = document.page(at: number) else { continue }
        let bounds = page.getBoxRect(.mediaBox)
        let width = Int(bounds.width * 2), height = Int(bounds.height * 2)
        guard width > 0 && height > 0, let context = CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:0,
            space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else { continue }
        context.setFillColor(CGColor(gray:1,alpha:1))
        context.fill(CGRect(x:0,y:0,width:width,height:height))
        context.concatenate(page.getDrawingTransform(.mediaBox,rect:CGRect(x:0,y:0,width:width,height:height),rotate:0,preserveAspectRatio:true))
        context.drawPDFPage(page)
        if let image = context.makeImage() { rows += try recognize(image,page:number,unit:0.5) }
    }
} else {
    guard let source = CGImageSourceCreateWithURL(url as CFURL,nil), let image = CGImageSourceCreateImageAtIndex(source,0,nil) else { throw NSError(domain:"OCR",code:2,userInfo:[NSLocalizedDescriptionKey:"图片无法读取"]) }
    rows = try recognize(image,page:1,unit:1)
}
let data = try JSONSerialization.data(withJSONObject:rows,options:[.sortedKeys])
print(String(data:data,encoding:.utf8)!)
