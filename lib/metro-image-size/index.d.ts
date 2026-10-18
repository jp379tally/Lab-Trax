export interface ImageDimensions {
  width: number;
  height: number;
  type: string;
}

export declare const types: readonly string[];
export declare function disableTypes(types: string[]): void;
export declare function imageSize(input: string | Uint8Array): ImageDimensions;
export default imageSize;