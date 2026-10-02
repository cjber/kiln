declare module "*.conf" {
  const text: string;
  export default text;
}

declare module "*.md" {
  const text: string;
  export default text;
}

declare module "*kiln-status.js" {
  const source: string;
  export default source;
}
