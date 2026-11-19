// 扫描版 PDF 的本地 OCR：用 macOS Vision 逐页识别，输出带页码标记的纯文本。
// 用法：swift scripts/ocrPdf.swift <input.pdf> <output.txt> [起始页] [结束页]
// 说明：只在本机运行，不上传任何内容；识别语言覆盖日文（含汉字假名）、简体中文与英文。

import Foundation
import CoreGraphics
import Vision
import ImageIO

func renderPage(_ page: CGPDFPage, scale: CGFloat, crop: String = "full") -> CGImage? {
    var box = page.getBoxRect(.mediaBox)
    // 扫描书常把两页拼成一页：按左右裁开分别识别，字号翻倍，识别率明显更好
    if crop == "left" {
        box.size.width = box.width / 2
    } else if crop == "right" {
        box.origin.x += box.width / 2
        box.size.width = box.width / 2
    }
    let width = Int(box.width * scale)
    let height = Int(box.height * scale)
    guard width > 0, height > 0 else { return nil }

    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    ) else { return nil }

    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    if crop == "full" {
        context.scaleBy(x: scale, y: scale)
        context.drawPDFPage(page)
    } else {
        context.scaleBy(x: scale, y: scale)
        context.translateBy(x: -box.origin.x, y: -box.origin.y)
        context.drawPDFPage(page)
    }
    return context.makeImage()
}

func recognize(_ image: CGImage) -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = (ProcessInfo.processInfo.environment["OCR_CORRECT"] ?? "1") == "1"
    request.recognitionLanguages = (ProcessInfo.processInfo.environment["OCR_LANGS"] ?? "ja-JP,zh-Hans,en-US").split(separator: ",").map(String.init)
    if #available(macOS 13.0, *) {
        request.revision = VNRecognizeTextRequestRevision3
    }

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return ""
    }

    guard let observations = request.results else { return "" }
    // 按视觉位置从上到下、从左到右排列，尽量还原阅读顺序
    let lines = observations.compactMap { observation -> (CGFloat, CGFloat, String)? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        return (1 - box.midY, box.minX, candidate.string)
    }
    .sorted { a, b in
        if abs(a.0 - b.0) < 0.012 { return a.1 < b.1 }
        return a.0 < b.0
    }

    // OCR_XY=1：每行带上归一化坐标（x 起点、y 中点），分栏排版要靠它自己排阅读顺序
    if (ProcessInfo.processInfo.environment["OCR_XY"] ?? "0") == "1" {
        return lines
            .map { String(format: "%.4f\t%.4f\t", $0.1, $0.0) + $0.2 }
            .joined(separator: "\n")
    }

    return lines.map { $0.2 }.joined(separator: "\n")
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("用法：swift ocrPdf.swift <input.pdf> <output.txt> [起始页] [结束页]\n".data(using: .utf8)!)
    exit(2)
}

let inputPath = args[1]
let outputPath = args[2]
guard let document = CGPDFDocument(URL(fileURLWithPath: inputPath) as CFURL) else {
    FileHandle.standardError.write("无法打开 PDF：\(inputPath)\n".data(using: .utf8)!)
    exit(1)
}

let total = document.numberOfPages
let from = args.count >= 4 ? max(1, Int(args[3]) ?? 1) : 1
let to = args.count >= 5 ? min(total, Int(args[4]) ?? total) : total

var output = ""
var processed = 0
let started = Date()

for index in from...to {
    guard let page = document.page(at: index) else { continue }
    let scale = CGFloat(Double(ProcessInfo.processInfo.environment["OCR_SCALE"] ?? "2") ?? 2)
    let crop = ProcessInfo.processInfo.environment["OCR_CROP"] ?? "full"
    guard let image = renderPage(page, scale: scale, crop: crop) else { continue }
    let text = recognize(image)
    output += "\n===== PAGE \(index) =====\n\(text)\n"
    processed += 1
    if processed % 10 == 0 {
        let elapsed = Date().timeIntervalSince(started)
        FileHandle.standardError.write("已识别 \(processed)/\(to - from + 1) 页 · \(String(format: "%.0f", elapsed))s\n".data(using: .utf8)!)
    }
}

try? output.write(toFile: outputPath, atomically: true, encoding: .utf8)
print("完成：\(inputPath) → \(outputPath)（\(processed) 页）")
