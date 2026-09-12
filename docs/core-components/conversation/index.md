# Conversations

Read agent responses and graph results, preview conversation files, and [share](share.md) or [export](export.md) conversations.

## Mathematical Formulas {#mathematical-formulas}

Markdown supports inline and display LaTeX formulas in:

- Chat messages and expanded reasoning, including streaming responses, conversation history, task conversations, and shared conversations.
- Graph final results.
- Markdown conversation-file previews, including split view.
- Prompt editor previews and Markdown preview cards.
- Built-in tool category descriptions.

Tool arguments and raw tool results keep their existing data display format.

### Inline and Display Syntax

Use single dollar signs for an inline formula, including within a Markdown table:

```text
The energy is $E = mc^2$.
```

Put each double-dollar delimiter on its own line for a display formula:

```text
$$
\frac{a}{b} = \sqrt{x}
$$
```

A fenced block with the `math` language also renders as a display formula:

````text
```math
\begin{pmatrix}
1 & 0 \\
0 & 1
\end{pmatrix}
```
````

Writing `$$x^2$$` on one line produces an inline formula.

Model responses can also use `\(...\)` for inline math and `\[...\]` for display math:

```text
The state value is \(V^*(s)\).

\[
V^*(s) = \max_a \sum_{s',r} p(s',r\mid s,a) [r + \gamma V^*(s')]
\]
```

Start a display formula on its own line; the closing `\]` can be followed only by whitespace. A standalone `\[x^2\]` also works. In the middle of a paragraph, `text \[x\] text` remains ordinary Markdown. Plain `(x)` and `[x]` are ordinary text.

To show literal delimiters outside code, double the backslashes: `\\(x\\)` and `\\[x\\]`. Inside a formula, `\\` remains a TeX row break, including spacing such as `\\[2pt]`.

### Dollar Signs and Code

Escape dollar signs in amounts with a backslash:

```text
Costs \$5 and \$10.
```

Unescaped paired dollar signs can be interpreted as a formula: `Costs $5 and $10` can format the text between the dollar signs as math. Expressions such as `$2x$` are valid formulas.

Inline code and ordinary fenced code blocks preserve formula source as code. For example, writing `` `$x^2$` `` shows the literal dollar signs and expression. Use a `text` or programming-language fence to show source; a `math` fence renders it.

### Streaming, Errors, and Long Formulas

While a response streams, an unfinished formula may appear as text or as a partially rendered formula. Unclosed bracket delimiters remain readable as Markdown; paragraph spacing may change temporarily around a display opener. The formula updates when its closing delimiter arrives. Invalid or unsupported formulas remain readable as TeX instead of interrupting the response; corrected content is rendered again.

Long inline and display formulas scroll horizontally within their formula area. Scroll that area to see the rest of the expression, including on narrow screens.

## Related Links

- [Share Conversations](share.md)
- [Export Conversations](export.md)
- [Create and Edit Prompts](../prompt/create-edit.md)
