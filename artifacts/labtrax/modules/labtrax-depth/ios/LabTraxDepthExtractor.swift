import Foundation
import AVFoundation
import CoreVideo
import ImageIO

enum LabTraxDepthAuxiliaryKind: String {
  case disparity
  case depth
}

struct LabTraxDepthCalibration {
  let fx: Float
  let fy: Float
  let cx: Float
  let cy: Float
  let referenceWidth: Float
  let referenceHeight: Float
}

struct LabTraxDepthFrame {
  let width: Int
  let height: Int
  let values: [Float]
  let calibration: LabTraxDepthCalibration?
}

enum LabTraxDepthExtractionError: LocalizedError {
  case noAuxiliaryData
  case invalidAuxiliaryData
  case unavailableBuffer
  case unavailableCalibration
  case invalidCalibration

  var errorDescription: String? {
    switch self {
    case .noAuxiliaryData: return "Photo has no depth or disparity auxiliary data"
    case .invalidAuxiliaryData: return "Depth auxiliary data is invalid"
    case .unavailableBuffer: return "Depth buffer is unavailable"
    case .unavailableCalibration: return "Depth camera calibration is unavailable"
    case .invalidCalibration: return "Depth camera calibration dimensions are invalid"
    }
  }
}

enum LabTraxDepthExtractor {
  typealias Decoder = (_ payload: Any, _ orientation: UInt32) -> LabTraxDepthFrame?

  static func extract(
    disparityPayload: Any?,
    depthPayload: Any?,
    exifOrientation: UInt32,
    maxDimension: Int,
    decoder: Decoder
  ) throws -> [String: Any] {
    let payload: Any
    if let disparityPayload {
      payload = disparityPayload
    } else if let depthPayload {
      payload = depthPayload
    } else {
      throw LabTraxDepthExtractionError.noAuxiliaryData
    }

    guard let frame = decoder(payload, exifOrientation) else {
      throw LabTraxDepthExtractionError.invalidAuxiliaryData
    }
    guard frame.width > 0, frame.height > 0, frame.values.count == frame.width * frame.height else {
      throw LabTraxDepthExtractionError.unavailableBuffer
    }
    guard let calibration = frame.calibration else {
      throw LabTraxDepthExtractionError.unavailableCalibration
    }
    guard calibration.referenceWidth > 0, calibration.referenceHeight > 0,
          calibration.fx.isFinite, calibration.fy.isFinite,
          calibration.cx.isFinite, calibration.cy.isFinite else {
      throw LabTraxDepthExtractionError.invalidCalibration
    }

    let boundedDimension = max(1, maxDimension)
    let scale = min(1.0, Double(boundedDimension) / Double(max(frame.width, frame.height)))
    let width = max(1, Int((Double(frame.width) * scale).rounded()))
    let height = max(1, Int((Double(frame.height) * scale).rounded()))
    var values = [Float]()
    values.reserveCapacity(width * height)
    for y in 0..<height {
      let sourceY = min(frame.height - 1, Int(Double(y) / scale))
      for x in 0..<width {
        let sourceX = min(frame.width - 1, Int(Double(x) / scale))
        let value = frame.values[sourceY * frame.width + sourceX]
        values.append(value.isFinite && value > 0 ? value : 0)
      }
    }

    let scaleX = Float(width) / calibration.referenceWidth
    let scaleY = Float(height) / calibration.referenceHeight
    let intrinsics: [String: Any] = [
      "fx": calibration.fx * scaleX,
      "fy": calibration.fy * scaleY,
      "cx": calibration.cx * scaleX,
      "cy": calibration.cy * scaleY,
      "referenceWidth": calibration.referenceWidth,
      "referenceHeight": calibration.referenceHeight
    ]
    let json: [String: Any] = [
      "version": 1,
      "kind": "depth",
      "unit": "meters",
      "width": width,
      "height": height,
      "sourceWidth": frame.width,
      "sourceHeight": frame.height,
      "values": values,
      "intrinsics": intrinsics
    ]
    let data = try JSONSerialization.data(withJSONObject: json)
    return [
      "ok": true,
      "json": String(data: data, encoding: .utf8) ?? "",
      "width": width,
      "height": height,
      "sourceWidth": frame.width,
      "sourceHeight": frame.height,
      "intrinsics": intrinsics
    ]
  }
}

@available(iOS 11.0, macOS 10.13, *)
enum AppleLabTraxDepthExtractor {
  static func extractDepthData(
    photoPath: String,
    outputPath: String?,
    maxDimension: Int
  ) -> [String: Any] {
    extractionResult(outputPath: outputPath) {
      try extractPhoto(photoPath: photoPath, maxDimension: maxDimension)
    }
  }

  static func extractionResult(
    outputPath: String?,
    operation: () throws -> [String: Any]
  ) -> [String: Any] {
    do {
      let result = try operation()
      if let outputPath,
         let json = result["json"] as? String,
         let data = json.data(using: .utf8) {
        let outputURL = fileURL(outputPath)
        try FileManager.default.createDirectory(
          at: outputURL.deletingLastPathComponent(),
          withIntermediateDirectories: true
        )
        try data.write(to: outputURL, options: .atomic)
      }
      return result
    } catch {
      return ["ok": false, "reason": (error as NSError).localizedDescription]
    }
  }

  static func extractPhoto(photoPath: String, maxDimension: Int) throws -> [String: Any] {
    let url = fileURL(photoPath)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else {
      throw NSError(
        domain: "LabTraxDepth",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Image could not be read"]
      )
    }
    let disparity = CGImageSourceCopyAuxiliaryDataInfoAtIndex(
      source, 0, kCGImageAuxiliaryDataTypeDisparity
    )
    let depth = CGImageSourceCopyAuxiliaryDataInfoAtIndex(
      source, 0, kCGImageAuxiliaryDataTypeDepth
    )
    let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1
    return try extract(
      disparityPayload: disparity,
      depthPayload: depth,
      exifOrientation: orientation,
      maxDimension: maxDimension
    )
  }

  static func extract(
    disparityPayload: Any?,
    depthPayload: Any?,
    exifOrientation: UInt32,
    maxDimension: Int
  ) throws -> [String: Any] {
    try LabTraxDepthExtractor.extract(
      disparityPayload: disparityPayload,
      depthPayload: depthPayload,
      exifOrientation: exifOrientation,
      maxDimension: maxDimension,
      decoder: decode
    )
  }

  private static func decode(payload: Any, orientationRaw: UInt32) -> LabTraxDepthFrame? {
    guard let dictionary = payload as? [AnyHashable: Any],
          let depthData = try? AVDepthData(fromDictionaryRepresentation: dictionary) else {
      return nil
    }
    let orientation = CGImagePropertyOrientation(rawValue: orientationRaw) ?? .up
    let oriented = depthData.applyingExifOrientation(orientation)
    let converted = oriented.depthDataType == kCVPixelFormatType_DepthFloat32
      ? oriented : oriented.converting(toDepthDataType: kCVPixelFormatType_DepthFloat32)
    let buffer = converted.depthDataMap
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    let stride = CVPixelBufferGetBytesPerRow(buffer) / MemoryLayout<Float32>.size
    guard let base = CVPixelBufferGetBaseAddress(buffer)?.assumingMemoryBound(to: Float32.self) else {
      return LabTraxDepthFrame(width: 0, height: 0, values: [], calibration: nil)
    }
    var values = [Float]()
    values.reserveCapacity(width * height)
    for y in 0..<height {
      for x in 0..<width {
        values.append(base[y * stride + x])
      }
    }
    let calibration = converted.cameraCalibrationData.map {
      let matrix = $0.intrinsicMatrix
      let reference = $0.intrinsicMatrixReferenceDimensions
      return LabTraxDepthCalibration(
        fx: matrix.columns.0.x,
        fy: matrix.columns.1.y,
        cx: matrix.columns.2.x,
        cy: matrix.columns.2.y,
        referenceWidth: Float(reference.width),
        referenceHeight: Float(reference.height)
      )
    }
    return LabTraxDepthFrame(
      width: width,
      height: height,
      values: values,
      calibration: calibration
    )
  }

  private static func fileURL(_ path: String) -> URL {
    URL(fileURLWithPath: path.replacingOccurrences(of: "file://", with: ""))
  }
}