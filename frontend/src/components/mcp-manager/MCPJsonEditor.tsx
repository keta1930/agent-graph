// src/components/mcp-manager/MCPJsonEditor.tsx
import React, { useState, useEffect, useRef } from 'react';
import { Button, message, Alert, Card, Tooltip } from 'antd';
import {
  Check,
  Copy,
  Save,
  Paintbrush,
  Info,
  AlertTriangle
} from 'lucide-react';
import { MCPConfig, MCPServerConfig } from '../../types/mcp';
import Editor from "@monaco-editor/react";
import { useT } from '../../i18n/hooks';

interface MCPJsonEditorProps {
  config: MCPConfig;
  onSave: (config: MCPConfig) => Promise<void>;
  loading: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

const stringArray = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new Error('Expected a string array');
  return value;
};

const resolveTransportType = (config: Record<string, unknown>): MCPServerConfig['transportType'] => {
  const alias = typeof config.type === 'string' ? config.type.toLowerCase().replace(/-/g, '_') : undefined;
  let transport = config.transportType === undefined ? 'stdio' : config.transportType;
  if (alias === 'stdio' || alias === 'sse' || alias === 'streamable_http') transport = alias;

  if (transport === 'stdio' || transport === '') return config.url ? 'streamable_http' : 'stdio';
  if (transport === 'sse') return 'sse';
  if (typeof transport === 'string' && ['streamable_http', 'streamablehttp'].includes(transport.toLowerCase().replace(/-/g, '_'))) {
    return 'streamable_http';
  }
  throw new Error('Invalid transport type');
};

const cleanServerConfigForEditor = (config: unknown): MCPServerConfig => {
  if (!isRecord(config)) throw new Error('Expected a server object');
  const transportType = resolveTransportType(config);
  if (config.disabled !== undefined && typeof config.disabled !== 'boolean') throw new Error('Invalid disabled value');
  if (config.timeout !== undefined && (typeof config.timeout !== 'number' || config.timeout <= 0)) throw new Error('Invalid timeout');
  
  const cleanConfig: MCPServerConfig = {
    autoApprove: stringArray(config.autoApprove),
    args: [],
    disabled: Boolean(config.disabled),
    timeout: typeof config.timeout === 'number' ? config.timeout : 60,
    transportType: transportType,
  };

  if (transportType === 'stdio') {
    if (typeof config.command !== 'string' || !config.command) throw new Error('Expected a stdio command');
    cleanConfig.command = config.command;
    if (Array.isArray(config.args) && config.args.length > 0) {
      cleanConfig.args = stringArray(config.args);
    }
  } else {
    if (typeof config.url !== 'string' || !config.url) throw new Error('Expected a server URL');
    cleanConfig.url = config.url;
  }

  // 添加：保留 ai_generated 字段
  if (config.ai_generated === true) {
    cleanConfig.ai_generated = true;
  }

  // 保留 provider 信息字段（团队共享，标记提供者）
  if (config.provider_user_id && typeof config.provider_user_id === 'string') {
    cleanConfig.provider_user_id = config.provider_user_id;
  }
  if (config.created_at && typeof config.created_at === 'string') {
    cleanConfig.created_at = config.created_at;
  }

  if (config.env && typeof config.env === 'object' && !Array.isArray(config.env) && Object.keys(config.env).length > 0) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.env)) {
      if (typeof value !== 'string') throw new Error('Invalid environment value');
      env[key] = value;
    }
    cleanConfig.env = env;
  }

  if (config.headers && typeof config.headers === 'object' && !Array.isArray(config.headers) && Object.keys(config.headers).length > 0) {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.headers)) {
      if (typeof value !== 'string') throw new Error('Invalid header value');
      headers[key] = value;
    }
    cleanConfig.headers = headers;
  }

  return cleanConfig;
};

const cleanFullConfigForEditor = (config: unknown): MCPConfig => {
  if (!isRecord(config)) throw new Error('Expected a configuration object');
  const servers = 'mcpServers' in config ? config.mcpServers : config;
  if (!isRecord(servers) || (servers === config && Object.keys(servers).length === 0)) {
    throw new Error('Expected a server map or mcpServers object');
  }
  return {
    mcpServers: Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, cleanServerConfigForEditor(server)])),
  };
};

const MCPJsonEditor: React.FC<MCPJsonEditorProps> = ({
  config,
  onSave,
  loading
}) => {
  const t = useT();
  const edited = useRef(false);
  const [jsonText, setJsonText] = useState('');
  const latestText = useRef(jsonText);
  latestText.current = jsonText;
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (edited.current) return;
    try {
      const cleanedConfig = cleanFullConfigForEditor(config);
      const formatted = JSON.stringify(cleanedConfig, null, 2);
      setJsonText(formatted);
      setError(null);
    } catch {
      setJsonText(JSON.stringify(config, null, 2));
      setError(t('pages.mcpManager.jsonEditor.invalidConfig'));
    }
  }, [config, t]);

  const handleJsonTextChange = (value: string | undefined) => {
    const newValue = value || '';
    edited.current = true;
    setJsonText(newValue);
    setError(null);
    setCopied(false);
  };

  const formatJson = () => {
    try {
      const parsed = JSON.parse(jsonText);
      const cleaned = cleanFullConfigForEditor(parsed);
      const formatted = JSON.stringify(cleaned, null, 2);
      setJsonText(formatted);
      setError(null);
      message.success(t('pages.mcpManager.jsonEditor.formatSuccess'));
    } catch {
      setError(t('pages.mcpManager.jsonEditor.formatFailed'));
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    
    try {
      const cleanedConfig = cleanFullConfigForEditor(JSON.parse(jsonText));
      await onSave(cleanedConfig);
      edited.current = latestText.current !== jsonText;

    } catch (err) {
      if (err instanceof Error && 'isVersionConflict' in err && err.isVersionConflict) {
        const errorMsg = t('pages.mcpManager.versionConflict', { message: err.message });
        message.error({
          content: errorMsg,
          duration: 5
        });
      } else {
        const errorMsg = t('pages.mcpManager.configSaveFailed', { error: err instanceof Error ? err.message : String(err) });
        setError(errorMsg);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(jsonText).then(() => {
      setCopied(true);
      message.success(t('pages.mcpManager.jsonEditor.copySuccess'));
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginBottom: '16px'
      }}>
        <span style={{
          fontSize: '16px',
          fontWeight: 500,
          color: '#2d2d2d',
          letterSpacing: '0.5px'
        }}>
          {t('pages.mcpManager.jsonEditor.title')}
        </span>
        <Tooltip title={t('pages.mcpManager.jsonEditor.tooltip')}>
          <Info size={16} strokeWidth={1.5} style={{ color: '#8b7355', cursor: 'pointer' }} />
        </Tooltip>
      </div>

      {error && (
        <Alert
          message={t('pages.mcpManager.jsonEditor.error')}
          description={error}
          type="error"
          showIcon
          icon={<AlertTriangle size={16} strokeWidth={1.5} />}
          closable
          onClose={() => setError(null)}
          style={{
            margin: '0 0 16px 0',
            borderRadius: '6px',
            border: '1px solid rgba(184, 88, 69, 0.3)',
            background: 'rgba(255, 245, 243, 0.9)'
          }}
        />
      )}

      <Card
        style={{
          borderRadius: '6px',
          border: '1px solid rgba(139, 115, 85, 0.15)',
          boxShadow: '0 1px 3px rgba(139, 115, 85, 0.06)',
          background: 'rgba(255, 255, 255, 0.85)',
          overflow: 'hidden'
        }}
        styles={{
          body: { padding: '0' }
        }}
      >
        <Editor
          height="600px"
          defaultLanguage="json"
          value={jsonText}
          onChange={handleJsonTextChange}
          onMount={(_editor, monaco) => {
            // Define custom theme
            monaco.editor.defineTheme('mcp-editor-theme', {
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
            // Set the custom theme
            monaco.editor.setTheme('mcp-editor-theme');
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
          }}
          theme="mcp-editor-theme"
        />
      </Card>

      <div style={{
        display: 'flex',
        gap: '8px',
        marginTop: '16px',
        justifyContent: 'flex-end'
      }}>
        <Button
          onClick={formatJson}
          style={{
            height: '36px',
            borderRadius: '6px',
            border: '1px solid rgba(139, 115, 85, 0.2)',
            background: 'rgba(255, 255, 255, 0.85)',
            color: '#8b7355',
            fontSize: '14px',
            fontWeight: 500,
            letterSpacing: '0.3px',
            boxShadow: '0 1px 3px rgba(139, 115, 85, 0.08)',
            transition: 'all 0.3s ease',
            display: 'flex',
            alignItems: 'center',
            gap: '6px'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = '#b85845';
            e.currentTarget.style.color = '#b85845';
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.95)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'rgba(139, 115, 85, 0.2)';
            e.currentTarget.style.color = '#8b7355';
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.85)';
          }}
        >
          <Paintbrush size={16} strokeWidth={1.5} />
          {t('pages.mcpManager.jsonEditor.formatAndClean')}
        </Button>

        <Button
          onClick={handleCopy}
          style={{
            height: '36px',
            borderRadius: '6px',
            border: '1px solid rgba(139, 115, 85, 0.2)',
            background: 'rgba(255, 255, 255, 0.85)',
            color: '#8b7355',
            fontSize: '14px',
            fontWeight: 500,
            letterSpacing: '0.3px',
            boxShadow: '0 1px 3px rgba(139, 115, 85, 0.08)',
            transition: 'all 0.3s ease',
            display: 'flex',
            alignItems: 'center',
            gap: '6px'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = '#b85845';
            e.currentTarget.style.color = '#b85845';
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.95)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'rgba(139, 115, 85, 0.2)';
            e.currentTarget.style.color = '#8b7355';
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.85)';
          }}
        >
          {copied ? <Check size={16} strokeWidth={1.5} /> : <Copy size={16} strokeWidth={1.5} />}
          {copied ? t('pages.mcpManager.jsonEditor.copied') : t('pages.mcpManager.jsonEditor.copy')}
        </Button>

        <Button
          onClick={handleSave}
          disabled={!!error || loading || saving}
          loading={loading || saving}
          style={{
            height: '36px',
            background: (!!error || loading || saving) ? 'rgba(139, 115, 85, 0.1)' : 'linear-gradient(135deg, #b85845 0%, #a0826d 100%)',
            border: 'none',
            borderRadius: '6px',
            color: (!!error || loading || saving) ? 'rgba(139, 115, 85, 0.4)' : '#fff',
            fontSize: '14px',
            fontWeight: 500,
            letterSpacing: '0.3px',
            boxShadow: (!!error || loading || saving) ? 'none' : '0 2px 6px rgba(184, 88, 69, 0.25)',
            transition: 'all 0.3s ease',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            cursor: (!!error || loading || saving) ? 'not-allowed' : 'pointer'
          }}
          onMouseEnter={(e) => {
            if (!error && !loading && !saving) {
              e.currentTarget.style.boxShadow = '0 4px 12px rgba(184, 88, 69, 0.35)';
            }
          }}
          onMouseLeave={(e) => {
            if (!error && !loading && !saving) {
              e.currentTarget.style.boxShadow = '0 2px 6px rgba(184, 88, 69, 0.25)';
            }
          }}
        >
          <Save size={16} strokeWidth={1.5} />
          {t('pages.mcpManager.jsonEditor.saveConfig')}
        </Button>
      </div>
    </div>
  );
};

export default MCPJsonEditor;
