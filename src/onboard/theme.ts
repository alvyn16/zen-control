/**
 * Tiny ANSI theme for the onboarding CLI. Styling is disabled for pipes,
 * `NO_COLOR`, and dumb terminals so captured output stays readable.
 */
export interface Theme {
  unicode: boolean;
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
}

export function createTheme(stream: NodeJS.WriteStream): Theme {
  const colorsEnabled =
    Boolean(stream.isTTY) &&
    !process.env.NO_COLOR &&
    process.env.TERM !== "dumb";

  const paint = (code: string) => (text: string): string =>
    colorsEnabled ? `\u001b[${code}m${text}\u001b[0m` : text;

  return {
    unicode: Boolean(stream.isTTY),
    bold: paint("1"),
    dim: paint("2"),
    green: paint("32"),
    red: paint("31"),
    yellow: paint("33"),
  };
}
