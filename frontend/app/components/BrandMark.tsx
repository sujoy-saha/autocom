/** AutoCom's logo mark: a stylized "A" whose crossbar is a checkmark/arrow,
 * standing in for "orders that complete themselves." Rendered as inline SVG
 * (not an emoji) so it reads as an actual product mark and stays crisp at
 * any size, sitting inside the existing `.brand-mark` gradient chip. */
export function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 19 L11.2 5 Q12 3.6 12.8 5 L20 19" />
      <path d="M8.2 13.4 L11 16.6 L16 10.4" />
    </svg>
  );
}
