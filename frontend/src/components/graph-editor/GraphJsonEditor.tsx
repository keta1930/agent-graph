// 图JSON编辑器组件
import { useState, useImperativeHandle, forwardRef } from 'react';
import { Alert } from 'antd';
import { AlertTriangle, Paintbrush } from 'lucide-react';
import Editor from "@monaco-editor/react";
import { parseGraphConfig } from '../../utils/graphEditorModel';
import { getErrorMessage } from '../../utils/errors';
import { BackendGraphConfig } from '../../types/graph';

interface GraphJsonEditorProps {
  graphConfig: BackendGraphConfig;
  value?: string;
  onChange?: (text: string) => void;
}

export interface GraphJsonEditorHandle {
  getJsonText: () => string;
  validateAndGetConfig: () => { valid: boolean; config?: BackendGraphConfig; error?: string };
}

/**
 * 图JSON编辑器
 * 不进行实时验证和同步，用户可以自由编辑
 */
const GraphJsonEditor = forwardRef<GraphJsonEditorHandle, GraphJsonEditorProps>(({
  graphConfig, value, onChange
}, ref) => {
  const [localText, setLocalText] = useState(() => JSON.stringify(graphConfig, null, 2));
  const jsonText = value ?? localText;
  const [syntaxError, setSyntaxError] = useState<string | null>(null);
  const handleJsonTextChange = (text: string | undefined) => {
    const next = text ?? '';
    setLocalText(next);
    onChange?.(next);
    setSyntaxError(null);
  };
  const formatJson = () => {
    try { handleJsonTextChange(JSON.stringify(JSON.parse(jsonText), null, 2)); }
    catch { setSyntaxError('Cannot format invalid JSON syntax'); }
  };
  useImperativeHandle(ref, () => ({
    getJsonText: () => jsonText,
    validateAndGetConfig: () => {
      try { return { valid: true, config: parseGraphConfig(JSON.parse(jsonText)) }; }
      catch (error) { return { valid: false, error: getErrorMessage(error, 'Invalid JSON syntax') }; }
    }
  }));

  return (
    <div style={{
      position: 'relative',
      height: '100%',
      width: '100%'
    }}>
      {/* 语法错误提示（仅显示格式化失败等严重错误） */}
      {syntaxError && (
        <div style={{
          position: 'absolute',
          top: '16px',
          left: '16px',
          right: '16px',
          zIndex: 10
        }}>
          <Alert
            message="JSON Error"
            description={syntaxError}
            type="error"
            showIcon
            icon={<AlertTriangle size={16} strokeWidth={1.5} />}
            closable
            onClose={() => setSyntaxError(null)}
            style={{
              borderRadius: '6px',
              border: '1px solid rgba(184, 88, 69, 0.3)',
              background: 'rgba(255, 245, 243, 0.95)',
              backdropFilter: 'blur(8px)',
              boxShadow: '0 2px 8px rgba(184, 88, 69, 0.15)'
            }}
          />
        </div>
      )}

      {/* JSON编辑器 */}
      <Editor
        height="100%"
        defaultLanguage="json"
        value={jsonText}
        onChange={handleJsonTextChange}
        onMount={(_editor, monaco) => {

          // 定义与MCP编辑器相同的主题
          monaco.editor.defineTheme('graph-editor-theme', {
            base: 'vs',
            inherit: true,
            rules: [
              { token: 'comment', foreground: '8b7355', fontStyle: 'italic' },
              { token: 'keyword', foreground: 'b85845', fontStyle: 'bold' },
              { token: 'string', foreground: 'a0826d' },
              { token: 'number', foreground: 'd4a574' },
              { token: 'type', foreground: '8b7355' },
              { token: 'function', foreground: 'b85845' },
            ],
            colors: {
              'editor.background': '#faf8f5',
              'editor.foreground': '#2d2d2d',
              'editor.lineHighlightBackground': '#f5f3f0',
              'editor.selectionBackground': '#e8dfd5',
              'editor.inactiveSelectionBackground': '#f0ebe5',
              'editorLineNumber.foreground': '#a89f92',
              'editorLineNumber.activeForeground': '#8b7355',
              'editorCursor.foreground': '#b85845',
              'editor.selectionHighlightBackground': '#e8dfd588',
              'editorIndentGuide.background': '#e5ddd3',
              'editorIndentGuide.activeBackground': '#8b7355',
            },
          });
          monaco.editor.setTheme('graph-editor-theme');
        }}
        options={{
          minimap: { enabled: true },
          fontSize: 14,
          formatOnPaste: true,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          wordWrap: 'on',
          tabSize: 2,
          folding: true,
          showFoldingControls: 'always',
          lineNumbers: 'on',
          padding: { top: 16, bottom: 16 },
          readOnly: false,
          domReadOnly: false,
        }}
        theme="graph-editor-theme"
      />

      {/* 格式化按钮（右下角） */}
      <div style={{
        position: 'absolute',
        bottom: '24px',
        right: '24px',
        zIndex: 10
      }}>
        <button
          onClick={formatJson}
          style={{
            height: '36px',
            padding: '0 16px',
            borderRadius: '6px',
            border: '1px solid rgba(139, 115, 85, 0.2)',
            background: 'rgba(255, 255, 255, 0.95)',
            color: '#8b7355',
            fontSize: '14px',
            fontWeight: 500,
            letterSpacing: '0.3px',
            boxShadow: '0 2px 8px rgba(139, 115, 85, 0.15)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            transition: 'all 0.2s ease',
            backdropFilter: 'blur(8px)'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = '#b85845';
            e.currentTarget.style.color = '#b85845';
            e.currentTarget.style.background = 'rgba(255, 255, 255, 1)';
            e.currentTarget.style.transform = 'translateY(-2px)';
            e.currentTarget.style.boxShadow = '0 4px 12px rgba(139, 115, 85, 0.25)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'rgba(139, 115, 85, 0.2)';
            e.currentTarget.style.color = '#8b7355';
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.95)';
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = '0 2px 8px rgba(139, 115, 85, 0.15)';
          }}
        >
          <Paintbrush size={16} strokeWidth={1.5} />
          Format
        </button>
      </div>
    </div>
  );
});

GraphJsonEditor.displayName = 'GraphJsonEditor';

export default GraphJsonEditor;
