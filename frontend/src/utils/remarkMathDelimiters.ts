import type {} from 'micromark-extension-math';
import type {} from 'remark-parse';
import { factorySpace } from 'micromark-factory-space';
import { markdownLineEnding } from 'micromark-util-character';
import type { Code, Construct, State, Tokenizer } from 'micromark-util-types';
import type { Processor } from 'unified';

/** 只在同一 Markdown 容器内跨行继续块公式。 */
const nonLazyContinuation: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    const { parser } = this;
    const currentLine = () => this.now().line;
    return start;
    function start(code: Code): ReturnType<State> {
      effects.enter('lineEnding');
      effects.consume(code);
      effects.exit('lineEnding');
      return lineStart;
    }
    function lineStart(code: Code): ReturnType<State> {
      return parser.lazy[currentLine()] ? nok(code) : ok(code);
    }
  },
};

/** 在原始字符流识别固定的 LaTeX 分隔符，复用官方数学 token。 */
function delimiter(display: boolean): Construct {
  const outer = display ? 'mathFlow' : 'mathText';
  const sequence = display ? 'mathFlowFenceSequence' : 'mathTextSequence';
  const value = display ? 'mathFlowValue' : 'mathTextData';
  const opening = display ? 91 : 40;
  const closing = display ? 93 : 41;
  const tokenize: Tokenizer = function (effects, ok, nok) {
    const { interrupt, events } = this;
    const tail = events[events.length - 1];
    const indent = display && tail?.[1].type === 'linePrefix' ? this.sliceSerialize(tail[1], true).length : 0;

    /** 先确认 opener，其他反斜杠交回 CommonMark。 */
    function start(code: Code): ReturnType<State> {
      effects.enter(outer);
      if (display) effects.enter('mathFlowFence');
      effects.enter(sequence);
      effects.consume(code);
      return open;
    }
    function open(code: Code): ReturnType<State> {
      if (code !== opening) return nok(code);
      effects.consume(code);
      effects.exit(sequence);
      if (display) effects.exit('mathFlowFence');
      return afterOpen;
    }
    function afterOpen(code: Code): ReturnType<State> {
      // 中断探针只确认块起点；实际构造仍要求找到完整 closing。
      if (display && interrupt) return ok(code);
      return between(code);
    }

    /** 数学正文保持原字符，反斜杠对作为不可拆开的 TeX 数据。 */
    function between(code: Code): ReturnType<State> {
      if (code === null) return nok(code);
      if (markdownLineEnding(code)) {
        if (display) return effects.attempt(nonLazyContinuation, nextLine, nok)(code);
        effects.enter('lineEnding');
        effects.consume(code);
        effects.exit('lineEnding');
        return between;
      }
      if (code === 92) return effects.attempt(close, finish, escapeStart)(code);
      effects.enter(value);
      return data(code);
    }
    function nextLine(code: Code): ReturnType<State> {
      return indent ? factorySpace(effects, between, 'linePrefix', indent + 1)(code) : between(code);
    }
    function data(code: Code): ReturnType<State> {
      if (code === null || code === 92 || markdownLineEnding(code)) {
        effects.exit(value);
        return between(code);
      }
      effects.consume(code);
      return data;
    }
    function escapeStart(code: Code): ReturnType<State> {
      effects.enter(value);
      effects.consume(code);
      return escapeNext;
    }
    function escapeNext(code: Code): ReturnType<State> {
      // 新 opener 让当前候选立即失败，避免每个未闭合 opener 扫到 EOF。
      if (code === opening) return nok(code);
      if (code === 92) {
        effects.consume(code);
        return data;
      }
      return data(code);
    }
    function finish(code: Code): ReturnType<State> {
      effects.exit(outer);
      return ok(code);
    }

    /** 块 closing 只接受行尾，失败时完整回退为数学正文。 */
    const close: Construct = {
      partial: true,
      tokenize(closeEffects, closeOk, closeNok) {
        return slash;
        function slash(code: Code): ReturnType<State> {
          if (display) closeEffects.enter('mathFlowFence');
          closeEffects.enter(sequence);
          closeEffects.consume(code);
          return bracket;
        }
        function bracket(code: Code): ReturnType<State> {
          if (code !== closing) return closeNok(code);
          closeEffects.consume(code);
          closeEffects.exit(sequence);
          return display ? factorySpace(closeEffects, end, 'whitespace') : closeOk;
        }
        function end(code: Code): ReturnType<State> {
          if (code !== null && !markdownLineEnding(code)) return closeNok(code);
          closeEffects.exit('mathFlowFence');
          return closeOk(code);
        }
      },
    };
    return start;
  };
  return { tokenize, concrete: display, name: display ? 'latexMathFlow' : 'latexMathText' };
}

/** 必须在 remarkMath 后注册，沿用其 mathFromMarkdown 节点处理器。 */
export default function remarkMathDelimiters(this: Processor) {
  const data = this.data();
  const extensions = data.micromarkExtensions || (data.micromarkExtensions = []);
  extensions.push({ text: { 92: delimiter(false) }, flow: { 92: delimiter(true) } });
}
