import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MarkdownPreview from '../conversation-file/MarkdownPreview';
import PromptEditor from '../prompt/PromptEditor';
import MarkdownRenderer from './MarkdownRenderer';
import CategoryReadmeModal from '../system-tools/CategoryReadmeModal';

const content = '$x^2$\n\n$$\n\\frac{1}{2}+\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}\n$$';
vi.mock('../../i18n/hooks', () => ({
  useT: () => (key: string) => key,
  useTranslation: () => ({ t: (key: string) => key, locale: 'en' }),
}));
vi.mock('../../constants/systemToolsData', () => ({ CATEGORY_README_DATA: { math: { en: '$x^2$\n\n$$\n\\frac{1}{2}\n$$' } } }));

describe('Markdown preview entry points', () => {
  beforeEach(() => {
    const getComputedStyle = window.getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element));
  });
  it.each([
    ['file', () => <MarkdownPreview filename="math.md" content={content} onChange={() => undefined} />],
    ['prompt', () => <PromptEditor content={content} onChange={() => undefined} />],
    ['card', () => <MarkdownRenderer content={content} />],
    ['category', () => <CategoryReadmeModal visible category="math" onClose={() => undefined} />],
  ] as const)('renders inline and display math in %s', (_, entry) => {
    const { baseElement } = render(entry());
    expect(baseElement.querySelectorAll('.katex')).toHaveLength(2);
    expect(baseElement.querySelectorAll('.katex-display')).toHaveLength(1);
  });

  it('preserves the card source toggle and safe custom links', () => {
    const { container } = render(<MarkdownRenderer content={'$x$ [link](https://example.com)'} showPreview />);
    expect(screen.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
    fireEvent.click(screen.getByRole('button', { name: /预览/ }));
    expect(container.querySelector('.katex')).not.toBeInTheDocument();
    expect(container.querySelector('pre')).toHaveTextContent('$x$ [link](https://example.com)');
  });
});
