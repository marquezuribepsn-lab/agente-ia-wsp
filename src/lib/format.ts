export function formatJidForDisplay(jid: string): string {
  return jid.replace(/@c\.us$/, "").replace(/@lid$/, "");
}
