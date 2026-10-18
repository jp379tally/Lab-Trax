import ExpoModulesCore

public class LabTraxDepthModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LabTraxDepth")
    Function("isAvailable") { () -> Bool in
      if #available(iOS 11.0, *) { return true }
      return false
    }
    AsyncFunction("extractDepthData") { (photoPath: String, outputPath: String?, maxDimension: Int?) -> [String: Any] in
      guard #available(iOS 11.0, *) else {
        return ["ok": false, "reason": "unsupported-ios"]
      }
      return AppleLabTraxDepthExtractor.extractDepthData(
        photoPath: photoPath,
        outputPath: outputPath,
        maxDimension: maxDimension ?? 128
      )
    }
  }
}