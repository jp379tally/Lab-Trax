import AVFoundation
import Foundation
import ImageIO
import XCTest
@testable import LabTraxDepthCore

final class LabTraxDepthExtractorTests: XCTestCase {
  func testRealDepthAndDisparityAuxiliaryPayloads() throws {
    let sourcePayload = try fixtureAuxiliaryPayload()
    let sourceDepth = try AVDepthData(fromDictionaryRepresentation: sourcePayload)

    for pixelFormat in [kCVPixelFormatType_DepthFloat32, kCVPixelFormatType_DisparityFloat32] {
      let converted = sourceDepth.converting(toDepthDataType: pixelFormat)
      var auxiliaryType: NSString?
      let payload = try XCTUnwrap(
        converted.dictionaryRepresentation(forAuxiliaryDataType: &auxiliaryType)
      )
      let result = try AppleLabTraxDepthExtractor.extract(
        disparityPayload: pixelFormat == kCVPixelFormatType_DisparityFloat32 ? payload : nil,
        depthPayload: pixelFormat == kCVPixelFormatType_DepthFloat32 ? payload : nil,
        exifOrientation: 1,
        maxDimension: 64
      )

      XCTAssertEqual(result["ok"] as? Bool, true)
      let width = try XCTUnwrap(result["width"] as? Int)
      let height = try XCTUnwrap(result["height"] as? Int)
      XCTAssertEqual(max(width, height), 64)
      XCTAssertGreaterThan(width, 0)
      XCTAssertGreaterThan(height, 0)
      XCTAssertNotNil(result["intrinsics"] as? [String: Any])
      XCTAssertFalse(try XCTUnwrap(result["json"] as? String).isEmpty)
    }
  }

  func testPortraitAndLandscapeExifOrientationRotateAndScaleIntrinsics() throws {
    let payload = try fixtureAuxiliaryPayload()
    let landscape = try AppleLabTraxDepthExtractor.extract(
      disparityPayload: payload,
      depthPayload: nil,
      exifOrientation: 1,
      maxDimension: 80
    )
    let portrait = try AppleLabTraxDepthExtractor.extract(
      disparityPayload: payload,
      depthPayload: nil,
      exifOrientation: 6,
      maxDimension: 80
    )

    XCTAssertEqual(landscape["sourceWidth"] as? Int, portrait["sourceHeight"] as? Int)
    XCTAssertEqual(landscape["sourceHeight"] as? Int, portrait["sourceWidth"] as? Int)
    XCTAssertEqual(landscape["width"] as? Int, portrait["height"] as? Int)
    XCTAssertEqual(landscape["height"] as? Int, portrait["width"] as? Int)
    try assertScaledIntrinsics(payload: payload, orientation: 1, result: landscape)
    try assertScaledIntrinsics(payload: payload, orientation: 6, result: portrait)
  }

  func testMissingCalibrationReturnsCameraOnlyFallbackAndDoesNotWriteOutput() throws {
    let output = temporaryOutputURL()
    let result = AppleLabTraxDepthExtractor.extractionResult(outputPath: output.path) {
      try LabTraxDepthExtractor.extract(
        disparityPayload: ["fixture": true],
        depthPayload: nil,
        exifOrientation: 1,
        maxDimension: 8
      ) { _, _ in
        LabTraxDepthFrame(width: 1, height: 1, values: [1], calibration: nil)
      }
    }

    XCTAssertEqual(result["ok"] as? Bool, false)
    XCTAssertEqual(result["reason"] as? String, "Depth camera calibration is unavailable")
    XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
  }

  func testMalformedCalibrationReturnsCameraOnlyFallbackAndDoesNotWriteOutput() throws {
    let output = temporaryOutputURL()
    let result = AppleLabTraxDepthExtractor.extractionResult(outputPath: output.path) {
      try LabTraxDepthExtractor.extract(
        disparityPayload: ["fixture": true],
        depthPayload: nil,
        exifOrientation: 1,
        maxDimension: 8
      ) { _, _ in
        LabTraxDepthFrame(
          width: 1,
          height: 1,
          values: [1],
          calibration: LabTraxDepthCalibration(
            fx: .nan,
            fy: 1,
            cx: 0,
            cy: 0,
            referenceWidth: 1,
            referenceHeight: 0
          )
        )
      }
    }

    XCTAssertEqual(result["ok"] as? Bool, false)
    XCTAssertEqual(result["reason"] as? String, "Depth camera calibration dimensions are invalid")
    XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
  }

  private func fixtureAuxiliaryPayload() throws -> [AnyHashable: Any] {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "image-with-depth", withExtension: "jpg"))
    let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
    let payload =
      CGImageSourceCopyAuxiliaryDataInfoAtIndex(source, 0, kCGImageAuxiliaryDataTypeDisparity) ??
      CGImageSourceCopyAuxiliaryDataInfoAtIndex(source, 0, kCGImageAuxiliaryDataTypeDepth)
    return try XCTUnwrap(payload as? [AnyHashable: Any])
  }

  private func assertScaledIntrinsics(
    payload: [AnyHashable: Any],
    orientation: UInt32,
    result: [String: Any],
    file: StaticString = #filePath,
    line: UInt = #line
  ) throws {
    let width = Float(try XCTUnwrap(result["width"] as? Int, file: file, line: line))
    let height = Float(try XCTUnwrap(result["height"] as? Int, file: file, line: line))
    let intrinsics = try XCTUnwrap(
      result["intrinsics"] as? [String: Any],
      file: file,
      line: line
    )
    let depthData = try AVDepthData(fromDictionaryRepresentation: payload)
      .applyingExifOrientation(try XCTUnwrap(CGImagePropertyOrientation(rawValue: orientation)))
      .converting(toDepthDataType: kCVPixelFormatType_DepthFloat32)
    let calibration = try XCTUnwrap(depthData.cameraCalibrationData, file: file, line: line)
    let matrix = calibration.intrinsicMatrix
    let reference = calibration.intrinsicMatrixReferenceDimensions
    let scaleX = width / Float(reference.width)
    let scaleY = height / Float(reference.height)
    XCTAssertEqual(
      try XCTUnwrap(intrinsics["fx"] as? Float), matrix.columns.0.x * scaleX,
      accuracy: 0.0001, file: file, line: line
    )
    XCTAssertEqual(
      try XCTUnwrap(intrinsics["fy"] as? Float), matrix.columns.1.y * scaleY,
      accuracy: 0.0001, file: file, line: line
    )
    XCTAssertEqual(
      try XCTUnwrap(intrinsics["cx"] as? Float), matrix.columns.2.x * scaleX,
      accuracy: 0.0001, file: file, line: line
    )
    XCTAssertEqual(
      try XCTUnwrap(intrinsics["cy"] as? Float), matrix.columns.2.y * scaleY,
      accuracy: 0.0001, file: file, line: line
    )
  }

  private func temporaryOutputURL() -> URL {
    FileManager.default.temporaryDirectory
      .appendingPathComponent("labtrax-depth-\(UUID().uuidString).json")
  }
}