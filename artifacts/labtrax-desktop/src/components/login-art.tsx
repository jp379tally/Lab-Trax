/** Reference-sourced standalone mark, scoped to the sign-in presentation. */
export function LoginBrandMark({ size = 54 }: { size?: number }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}brand/signin-reference-mark.png`}
      alt="LabTrax"
      width={size}
      height={size * (56 / 54)}
      className="shrink-0 object-contain"
    />
  );
}
