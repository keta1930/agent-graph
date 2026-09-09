// src/components/mcp-manager/MCPServerForm.tsx
import React, { useEffect, useRef, useState } from 'react';
import { Form, Input, InputNumber, Switch, Select, Modal, Button, Typography, ConfigProvider } from 'antd';
import { MCPServerConfig } from '../../types/mcp';
import { useT } from '../../i18n/hooks';

const { TextArea } = Input;
const { Text } = Typography;

interface MCPFields {
  disabled: boolean;
  timeout: number;
  transportType: MCPServerConfig['transportType'];
  command?: string;
  url?: string;
  serverName: string;
  envText: string;
  args: string;
  autoApprove: string;
}

interface MCPServerFormProps {
  visible: boolean;
  onClose: () => void;
  onSubmit: (serverName: string, config: MCPServerConfig) => Promise<void>;
  initialName?: string;
  initialValues?: MCPServerConfig;
  title: string;
}

const MCPServerForm: React.FC<MCPServerFormProps> = ({
  visible,
  onClose,
  onSubmit,
  initialName = '',
  initialValues,
  title,
}) => {
  const t = useT();
  const [form] = Form.useForm<MCPFields>();
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);
  const session = useRef(0);
  const record = useRef(initialValues);
  record.current = initialValues;
  const transportType = Form.useWatch('transportType', form);

  useEffect(() => {
    session.current++;
    pending.current = false;
    setSubmitting(false);
    if (!visible) return;
    const config = record.current;
    form.resetFields();
    form.setFieldsValue({
      ...config,
      serverName: initialName,
      disabled: config?.disabled ?? false,
      timeout: config?.timeout ?? 60,
      transportType: config?.transportType ?? 'stdio',
      command: config?.command ?? '',
      url: config?.url ?? '',
      args: config?.args?.join(', ') ?? '',
      autoApprove: config?.autoApprove?.join(', ') ?? '',
      envText: Object.entries(config?.env ?? {}).map(([key, value]) => key + '=' + value).join('\n'),
    });
  }, [visible, initialName, form]);

  const handleSubmit = async () => {
    if (pending.current) return;
    pending.current = true;
    setSubmitting(true);
    const owner = session.current;
    try {
      const { serverName, envText, args, autoApprove, ...values } = await form.validateFields();
      const env: Record<string, string> = {};
      for (const line of envText.split('\n')) {
        const separator = line.indexOf('=');
        if (separator > 0) env[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
      }
      const serverConfig: MCPServerConfig = {
        ...values,
        env,
        args: args.split(',').map(value => value.trim()).filter(Boolean),
        autoApprove: autoApprove.split(',').map(value => value.trim()).filter(Boolean),
      };
      if (serverConfig.transportType === 'stdio') delete serverConfig.url;
      else { delete serverConfig.command; serverConfig.args = []; }
      if (owner !== session.current) return;
      await onSubmit(serverName, serverConfig);
      if (owner === session.current) form.resetFields();
    } catch {
      // 父页面展示请求错误，当前编辑周期保留草稿。
    } finally {
      if (owner === session.current) { pending.current = false; setSubmitting(false); }
    }
  };

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: '#b85845',
          colorPrimaryHover: '#a0826d',
          colorBorder: 'rgba(139, 115, 85, 0.2)',
          colorBorderSecondary: 'rgba(139, 115, 85, 0.15)',
          colorText: '#2d2d2d',
          colorTextPlaceholder: 'rgba(45, 45, 45, 0.35)',
          borderRadius: 6,
          controlHeight: 40,
        },
        components: {
          Input: {
            activeBorderColor: '#b85845',
            hoverBorderColor: 'rgba(184, 88, 69, 0.4)',
            activeShadow: '0 0 0 2px rgba(184, 88, 69, 0.1)',
          },
          InputNumber: {
            activeBorderColor: '#b85845',
            hoverBorderColor: 'rgba(184, 88, 69, 0.4)',
            activeShadow: '0 0 0 2px rgba(184, 88, 69, 0.1)',
          },
          Select: {
            optionSelectedBg: 'rgba(184, 88, 69, 0.08)',
            optionActiveBg: 'rgba(184, 88, 69, 0.05)',
          },
        },
      }}
    >
      <Modal
        title={title}
        open={visible}
        onCancel={onClose}
      footer={[
        <Button
          key="cancel"
          onClick={onClose}
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
            transition: 'all 0.3s ease'
          }}
        >
          {t('common.cancel')}
        </Button>,
        <Button
          key="submit"
          loading={submitting}
          onClick={handleSubmit}
          style={{
            height: '36px',
            background: 'linear-gradient(135deg, #b85845 0%, #a0826d 100%)',
            border: 'none',
            borderRadius: '6px',
            color: '#fff',
            fontSize: '14px',
            fontWeight: 500,
            letterSpacing: '0.3px',
            boxShadow: '0 2px 6px rgba(184, 88, 69, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.2)',
            transition: 'all 0.3s cubic-bezier(0.23, 1, 0.32, 1)'
          }}
        >
          {t('common.submit')}
        </Button>,
      ]}
      width={800}
    >
      <Form
        form={form}
        layout="vertical"
        name="mcpServerForm"
      >
        <Form.Item
          name="serverName"
          label={t('pages.mcpManager.form.serverName')}
          initialValue={initialName}
          rules={[{ required: true, message: t('pages.mcpManager.form.serverNameRequired') }]}
        >
          <Input disabled={!!initialName} />
        </Form.Item>

        <Form.Item
          name="disabled"
          label={t('pages.mcpManager.form.disabled')}
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          name="timeout"
          label={t('pages.mcpManager.form.timeout')}
          rules={[{ required: true, message: t('pages.mcpManager.form.timeoutRequired') }]}
        >
          <InputNumber min={1} max={300} style={{ width: '100%' }} />
        </Form.Item>

        <Form.Item
          name="transportType"
          label={t('pages.mcpManager.form.transportType')}
          rules={[{ required: true, message: t('pages.mcpManager.form.transportTypeRequired') }]}
        >
          <Select>
            <Select.Option value="stdio">{t('pages.mcpManager.form.transportStdio')}</Select.Option>
            <Select.Option value="sse">{t('pages.mcpManager.form.transportSse')}</Select.Option>
            <Select.Option value="streamable_http">{t('pages.mcpManager.form.transportHttp')}</Select.Option>
          </Select>
        </Form.Item>

        {/* STDIO specific fields */}
        {transportType === 'stdio' && (
          <>
            <Form.Item
              name="command"
              label={t('pages.mcpManager.form.command')}
              rules={[{ required: true, message: t('pages.mcpManager.form.commandRequired') }]}
            >
              <Input placeholder={t('pages.mcpManager.form.commandPlaceholder')} />
            </Form.Item>

            <Form.Item
              name="args"
              label={t('pages.mcpManager.form.args')}
            >
              <Input placeholder={t('pages.mcpManager.form.argsPlaceholder')} />
            </Form.Item>
          </>
        )}

        {/* SSE specific fields */}
        {(transportType === 'sse' || transportType === 'streamable_http') && (
          <Form.Item
            name="url"
            label={transportType === 'sse' ? t('pages.mcpManager.form.sseUrl') : t('pages.mcpManager.form.httpUrl')}
            rules={[{ required: true, message: t('pages.mcpManager.form.urlRequired') }]}
          >
            <Input placeholder={
              transportType === 'sse' 
                ? t('pages.mcpManager.form.sseUrlPlaceholder')
                : t('pages.mcpManager.form.httpUrlPlaceholder')
            } />
          </Form.Item>
        )}

        <Form.Item
          name="autoApprove"
          label={t('pages.mcpManager.form.autoApprove')}
        >
          <Input placeholder={t('pages.mcpManager.form.autoApprovePlaceholder')} />
        </Form.Item>

        <Form.Item
          name="envText"
          label={
            <div>
              <Text>{t('pages.mcpManager.form.envVars')}</Text>
              <br />
              <Text type="secondary" style={{ fontSize: '12px' }}>
                {t('pages.mcpManager.form.envVarsHelp')}
              </Text>
            </div>
          }
        >
          <TextArea
            rows={4}
            placeholder={t('pages.mcpManager.form.envVarsPlaceholder')}
          />
        </Form.Item>
      </Form>
    </Modal>
    </ConfigProvider>
  );
};

export default MCPServerForm;
