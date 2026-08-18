// Three markdown-it plugins ship without type declarations; these are the
// narrow shapes we actually use.

declare module 'markdown-it-footnote' {
  import type MarkdownIt from 'markdown-it';
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}

declare module 'markdown-it-emoji' {
  import type MarkdownIt from 'markdown-it';
  export const full: MarkdownIt.PluginSimple;
  export const light: MarkdownIt.PluginSimple;
  export const bare: MarkdownIt.PluginSimple;
}

declare module '@vscode/markdown-it-katex' {
  import type MarkdownIt from 'markdown-it';
  const plugin: MarkdownIt.PluginWithOptions<{
    enableFencedBlocks?: boolean;
    enableBareBlocks?: boolean;
    enableMathBlockInHtml?: boolean;
    enableMathInlineInHtml?: boolean;
  }>;
  export default plugin;
}
