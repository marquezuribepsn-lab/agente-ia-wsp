export function formatJidForDisplay(jid: string): string {
  return jid.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "");
}
