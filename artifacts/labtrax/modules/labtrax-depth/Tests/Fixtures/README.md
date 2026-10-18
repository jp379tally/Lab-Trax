# Native depth fixture

`image-with-depth.jpg` comes from
[shu223/iOS-Depth-Sampler](https://github.com/shu223/iOS-Depth-Sampler), an
MIT-licensed sample project. The adjacent license file preserves the upstream
license and attribution.

The bundled copy has its GPS metadata removed for privacy. The JPEG image,
including its Apple auxiliary-depth payload, is otherwise byte-for-byte
unchanged.

The XCTest suite reads its genuine Apple auxiliary-depth dictionary, then uses
`AVDepthData` to export both depth and disparity representations for regression
coverage.