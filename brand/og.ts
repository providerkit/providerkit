/** The avatar already uses the card's background. Embed it whole so they always share a mark. */
export function ogCardSvg(avatar: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#16191d"/>
  <g transform="translate(70 58) scale(1.1)">${avatar}</g>
  <g font-family="Archivo" fill="#e4e9ee">
    <text x="152" y="109" font-size="44" font-weight="650" letter-spacing="-1.5">providerkit</text>
    <text x="1120" y="102" text-anchor="end" font-size="26" fill="#b4bdc7">providerkit.dev</text>
    <text x="80" y="305" font-size="76" font-weight="600" letter-spacing="-2">Call models. Run agents.</text>
    <text x="80" y="393" font-size="76" font-weight="600" letter-spacing="-2">Build chat screens.</text>
    <text x="80" y="545" font-size="32" fill="#b4bdc7">Core, Agents and React for TypeScript.</text>
  </g>
</svg>\n`;
}
