import React, { forwardRef } from "react";

type NativeSvgProps<T extends SVGElement> = React.SVGProps<T> & {
  testID?: string;
  accessible?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  accessibilityState?: {
    selected?: boolean;
    checked?: boolean;
    disabled?: boolean;
  };
  onPress?: () => void;
};

function toSvgProps<T>(props: NativeSvgProps<T>) {
  const {
    testID,
    accessible: _accessible,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    onPress,
    ...svgProps
  } = props;
  return (
    {
      ...svgProps,
      "data-testid": testID,
      role: svgProps.role ?? accessibilityRole,
      "aria-label": svgProps["aria-label"] ?? accessibilityLabel,
      "aria-pressed": accessibilityState?.selected ?? accessibilityState?.checked,
      "aria-disabled": accessibilityState?.disabled,
      onClick: svgProps.onClick ?? onPress,
    }
  );
}

type SvgElementProps = NativeSvgProps<SVGSVGElement>;
export const Svg = forwardRef<SVGSVGElement, SvgElementProps>(function Svg(props, ref) {
  return <svg {...toSvgProps(props)} ref={ref} />;
});

export const Path = (props: NativeSvgProps<SVGPathElement>) => <path {...toSvgProps(props)} />;
export const Circle = (props: NativeSvgProps<SVGCircleElement>) => <circle {...toSvgProps(props)} />;
export const Ellipse = (props: NativeSvgProps<SVGEllipseElement>) => <ellipse {...toSvgProps(props)} />;
export const Image = (props: NativeSvgProps<SVGImageElement>) => <image {...toSvgProps(props)} />;
export const Text = (props: NativeSvgProps<SVGTextElement>) => <text {...toSvgProps(props)} />;
export const G = (props: NativeSvgProps<SVGGElement>) => <g {...toSvgProps(props)} />;

export default Svg;
