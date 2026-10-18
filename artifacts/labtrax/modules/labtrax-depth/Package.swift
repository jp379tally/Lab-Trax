// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "LabTraxDepthCore",
  platforms: [.macOS(.v12), .iOS(.v13)],
  products: [
    .library(name: "LabTraxDepthCore", targets: ["LabTraxDepthCore"])
  ],
  targets: [
    .target(
      name: "LabTraxDepthCore",
      path: "ios",
      exclude: ["LabTraxDepthModule.swift", "LabTraxDepth.podspec"]
    ),
    .testTarget(
      name: "LabTraxDepthCoreTests",
      dependencies: ["LabTraxDepthCore"],
      path: "Tests",
      resources: [.process("Fixtures")]
    )
  ]
)