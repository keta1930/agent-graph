import type { JsonObject } from '../../types/json';
// src/components/model-manager/ModelForm.tsx
import React, { useState, useRef } from 'react';
import { Form, Input, Modal, Button, InputNumber, Switch, Select } from 'antd';
import { ChevronDown } from 'lucide-react';
import { ModelConfig } from '../../types/model';
import { useT } from '../../i18n/hooks';

const { TextArea } = Input;

type ModelFields = Omit<ModelConfig, 'stop'> & { stop?: string; extra_body_json?: string };

interface ModelFormProps {
  visible: boolean;
  onClose: () => void;
  onSubmit: (model: ModelConfig) => Promise<void>;
  initialValues?: ModelConfig;
  title: string;
}

const ModelForm: React.FC<ModelFormProps> = ({
  visible,
  onClose,
  onSubmit,
  initialValues,
  title
}) => {
  const t = useT();
  const [form] = Form.useForm<ModelFields>();
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);
  const session = useRef(0);
  const record = useRef(initialValues);
  record.current = initialValues;
  const recordName = initialValues?.name;
  const [advancedExpanded, setAdvancedExpanded] = useState(false);

  React.useEffect(() => {
    session.current++;
    pending.current = false;
    setSubmitting(false);
    if (!visible) return;
    const values = record.current;
    form.resetFields();
    form.setFieldsValue({
      ...values,
      provider: values?.provider ?? 'openai',
      model_type: values?.model_type ?? 'llm',
      extra_body_json: values?.extra_body ? JSON.stringify(values.extra_body, null, 2) : '',
      stop: Array.isArray(values?.stop) ? values.stop.join(', ') : values?.stop ?? '',
      api_key: '',
    });
    setAdvancedExpanded(false);
  }, [visible, recordName, form]);

  const handleSubmit = async () => {
    if (pending.current) return;
    pending.current = true;
    setSubmitting(true);
    const owner = session.current;
    try {
      await form.validateFields();
      const values: ModelFields = form.getFieldsValue(true);
      const cleanedValues: ModelConfig = {
        name: values.name, base_url: values.base_url, model: values.model,
        provider: values.provider ?? 'openai', model_type: values.model_type ?? 'llm',
      };
      if (!initialValues || values.api_key?.trim()) cleanedValues.api_key = values.api_key?.trim() ?? '';
      const numericFields = ['temperature', 'max_tokens', 'max_completion_tokens', 'top_p',
        'frequency_penalty', 'presence_penalty', 'n', 'seed', 'top_logprobs', 'timeout'] as const;
      for (const field of numericFields) {
        const value = values[field];
        if (value !== undefined && value !== null && Number.isFinite(value)) cleanedValues[field] = value;
      }
      if (values.logprobs !== undefined) cleanedValues.logprobs = values.logprobs;
      if (values.stop?.trim()) {
        const stop = values.stop.trim();
        cleanedValues.stop = stop.includes(',') ? stop.split(',').map(value => value.trim()).filter(Boolean) : stop;
      }
      if (values.extra_body_json?.trim()) {
        let parsed: JsonObject;
        try { parsed = JSON.parse(values.extra_body_json); }
        catch {
          form.setFields([{ name: 'extra_body_json', errors: [t('pages.modelManager.form.invalidJson')] }]);
          setAdvancedExpanded(true);
          return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          form.setFields([{ name: 'extra_body_json', errors: [t('pages.modelManager.form.invalidJson')] }]);
          return;
        }
        cleanedValues.extra_body = parsed;
      }
      if (owner !== session.current) return;
      await onSubmit(cleanedValues);
      if (owner === session.current) form.resetFields();
    } catch {
      // 校验反馈由 Form 展示，请求失败由父页面展示；草稿保持原值。
    } finally {
      if (owner === session.current) { pending.current = false; setSubmitting(false); }
    }
  };

  return (
    <Modal
      title={title}
      open={visible}
      onCancel={onClose}
      width={600}
      styles={{
        header: {
          borderBottom: '1px solid rgba(139, 115, 85, 0.15)',
          paddingBottom: '16px',
          marginBottom: '20px'
        },
        body: {
          padding: '24px'
        }
      }}
      footer={[
        <Button
          key="cancel"
          onClick={onClose}
          style={{
            borderRadius: '6px',
            border: '1px solid rgba(139, 115, 85, 0.2)',
            background: 'rgba(255, 255, 255, 0.85)',
            color: '#8b7355',
            padding: '6px 16px',
            height: 'auto'
          }}
        >
          {t('common.cancel')}
        </Button>,
        <Button
          key="submit"
          loading={submitting}
          onClick={handleSubmit}
          style={{
            background: 'linear-gradient(135deg, #b85845 0%, #a0826d 100%)',
            border: 'none',
            borderRadius: '6px',
            color: '#fff',
            padding: '6px 16px',
            height: 'auto',
            fontWeight: 500,
            boxShadow: '0 2px 6px rgba(184, 88, 69, 0.25)',
            marginLeft: '8px'
          }}
        >
          {t('common.submit')}
        </Button>,
      ]}
    >
      <Form
        form={form}
        layout="vertical"
        name="modelForm"
      >
        {/* 基本配置 */}
        <Form.Item
          name="name"
          label={t('pages.modelManager.form.modelName')}
          rules={[{ required: true, message: t('pages.modelManager.form.modelNameRequired') }]}
        >
          <Input />
        </Form.Item>

        <Form.Item
          name="base_url"
          label={t('pages.modelManager.form.baseUrlLabel')}
          rules={[{ required: true, message: t('pages.modelManager.form.baseUrlRequired') }]}
        >
          <Input placeholder={t('pages.modelManager.form.baseUrlPlaceholder')} />
        </Form.Item>
        <Form.Item
          name="api_key"
          label={t('pages.modelManager.form.apiKey')}
          rules={[
            {
              required: !initialValues,
              message: t('pages.modelManager.form.apiKeyRequired')
            }
          ]}
        >
          <Input.Password placeholder={initialValues ? t('pages.modelManager.form.apiKeyPlaceholder') : ""} />
        </Form.Item>
        <Form.Item
          name="model"
          label={t('pages.modelManager.form.modelIdentifierLabel')}
          rules={[{ required: true, message: t('pages.modelManager.form.modelIdentifierRequired') }]}
        >
          <Input placeholder={t('pages.modelManager.form.modelIdentifierPlaceholder')} />
        </Form.Item>

        {/* Provider 选择器 */}
        <Form.Item
          name="provider"
          label={t('pages.modelManager.form.provider')}
          initialValue="openai"
          rules={[{ required: true, message: t('pages.modelManager.form.providerRequired') }]}
        >
          <Select placeholder={t('pages.modelManager.form.providerPlaceholder')}>
            <Select.Option value="openai">OpenAI</Select.Option>
          </Select>
        </Form.Item>

        {/* Model Type 选择器 */}
        <Form.Item
          name="model_type"
          label={t('pages.modelManager.form.modelType')}
          initialValue="llm"
          rules={[{ required: true, message: t('pages.modelManager.form.modelTypeRequired') }]}
        >
          <Select placeholder={t('pages.modelManager.form.modelTypePlaceholder')}>
            <Select.Option value="llm">{t('pages.modelManager.form.llmType')}</Select.Option>
          </Select>
        </Form.Item>

        {/* 高级配置 */}
        <div
          style={{
            marginTop: '16px',
            borderRadius: '8px',
            border: '1px solid rgba(139, 115, 85, 0.15)',
            background: 'rgba(250, 248, 245, 0.6)',
            overflow: 'hidden'
          }}
        >
          <div
            style={{
              padding: '12px 16px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              transition: 'background 0.2s ease'
            }}
            onClick={() => setAdvancedExpanded(!advancedExpanded)}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(250, 248, 245, 0.9)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            <span style={{
              fontWeight: 500,
              fontSize: '14px',
              color: '#2d2d2d'
            }}>
              {t('pages.modelManager.form.advancedConfig')}
            </span>
            <ChevronDown
              size={18}
              strokeWidth={2}
              style={{
                color: '#8b7355',
                transform: advancedExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 0.3s ease'
              }}
            />
          </div>
          {advancedExpanded && (
            <div style={{ padding: '16px', paddingTop: '8px' }}>
            <div style={{ paddingBottom: '24px' }}>
              <Form.Item
                name="temperature"
                label={t('pages.modelManager.form.temperature')}
                help={t('pages.modelManager.form.temperatureHelp')}
                style={{ marginBottom: '24px' }}
              >
                <InputNumber
                  min={0}
                  max={2}
                  step={0.1}
                  placeholder={t('pages.modelManager.form.temperaturePlaceholder')}
                  style={{ width: '100%' }}
                  precision={2}
                />
              </Form.Item>
            </div>

            <div style={{ paddingBottom: '24px' }}>
              <Form.Item
                name="max_tokens"
                label={t('pages.modelManager.form.maxTokens')}
                help={t('pages.modelManager.form.maxTokensHelp')}
                style={{ marginBottom: '24px' }}
              >
                <InputNumber
                  min={1}
                  placeholder={t('pages.modelManager.form.maxTokensPlaceholder')}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </div>

            <div style={{ paddingBottom: '24px' }}>
              <Form.Item
                name="max_completion_tokens"
                label={t('pages.modelManager.form.maxCompletionTokens')}
                help={t('pages.modelManager.form.maxCompletionTokensHelp')}
                style={{ marginBottom: '24px' }}
              >
                <InputNumber
                  min={1}
                  placeholder={t('pages.modelManager.form.maxCompletionTokensPlaceholder')}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </div>

            <div style={{ paddingBottom: '24px' }}>
              <Form.Item
                name="top_p"
                label={t('pages.modelManager.form.topP')}
                help={t('pages.modelManager.form.topPHelp')}
                style={{ marginBottom: '24px' }}
              >
                <InputNumber
                  min={0}
                  max={1}
                  step={0.1}
                  placeholder={t('pages.modelManager.form.topPPlaceholder')}
                  style={{ width: '100%' }}
                  precision={2}
                />
              </Form.Item>
            </div>

            <div style={{ paddingBottom: '24px' }}>
              <Form.Item
                name="frequency_penalty"
                label={t('pages.modelManager.form.frequencyPenalty')}
                help={t('pages.modelManager.form.frequencyPenaltyHelp')}
                style={{ marginBottom: '24px' }}
              >
                <InputNumber
                  min={-2}
                  max={2}
                  step={0.1}
                  placeholder={t('pages.modelManager.form.frequencyPenaltyPlaceholder')}
                  style={{ width: '100%' }}
                  precision={2}
                />
              </Form.Item>
            </div>

            <div style={{ paddingBottom: '24px' }}>
              <Form.Item
                name="presence_penalty"
                label={t('pages.modelManager.form.presencePenalty')}
                help={t('pages.modelManager.form.presencePenaltyHelp')}
                style={{ marginBottom: '24px' }}
              >
                <InputNumber
                  min={-2}
                  max={2}
                  step={0.1}
                  placeholder={t('pages.modelManager.form.presencePenaltyPlaceholder')}
                  style={{ width: '100%' }}
                  precision={2}
                />
              </Form.Item>
            </div>

            <div style={{ paddingBottom: '24px' }}>
              <Form.Item
                name="n"
                label={t('pages.modelManager.form.responseCount')}
                help={t('pages.modelManager.form.responseCountHelp')}
                style={{ marginBottom: '24px' }}
              >
                <InputNumber
                  min={1}
                  max={10}
                  placeholder={t('pages.modelManager.form.responseCountPlaceholder')}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </div>

            <div style={{ paddingBottom: '24px' }}>
              <Form.Item
                name="stop"
                label={t('pages.modelManager.form.stopSequence')}
                help={t('pages.modelManager.form.stopSequenceHelp')}
                style={{ marginBottom: '24px' }}
              >
                <Input placeholder={t('pages.modelManager.form.stopSequencePlaceholder')} />
              </Form.Item>
            </div>

            <div style={{ paddingBottom: '24px' }}>
              <Form.Item
                name="seed"
                label={t('pages.modelManager.form.seed')}
                help={t('pages.modelManager.form.seedHelp')}
                style={{ marginBottom: '24px' }}
              >
                <InputNumber
                  placeholder={t('pages.modelManager.form.seedPlaceholder')}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </div>

            <div style={{ paddingBottom: '24px' }}>
              <Form.Item
                name="logprobs"
                label={t('pages.modelManager.form.logprobs')}
                valuePropName="checked"
                style={{ marginBottom: '24px' }}
              >
                <Switch
                  style={{
                    backgroundColor: 'rgba(139, 115, 85, 0.2)'
                  }}
                  className="custom-switch"
                />
              </Form.Item>
            </div>

            <div style={{ paddingBottom: '24px' }}>
              <Form.Item
                name="top_logprobs"
                label={t('pages.modelManager.form.topLogprobs')}
                help={t('pages.modelManager.form.topLogprobsHelp')}
                style={{ marginBottom: '24px' }}
              >
                <InputNumber
                  min={0}
                  max={20}
                  placeholder={t('pages.modelManager.form.topLogprobsPlaceholder')}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </div>

            <div style={{ paddingBottom: '24px' }}>
              <Form.Item
                name="timeout"
                label={t('pages.modelManager.form.timeout')}
                help={t('pages.modelManager.form.timeoutHelp')}
                style={{ marginBottom: '24px' }}
              >
                <InputNumber
                  min={1}
                  placeholder={t('pages.modelManager.form.timeoutPlaceholder')}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </div>

            <div style={{ paddingBottom: '12px' }}>
              <Form.Item
                name="extra_body_json"
                label={t('pages.modelManager.form.extraBody')}
                help={t('pages.modelManager.form.extraBodyHelp')}
                style={{ marginBottom: '12px' }}
              >
                <TextArea
                  rows={4}
                  placeholder={t('pages.modelManager.form.extraBodyPlaceholder')}
                />
              </Form.Item>
            </div>
            </div>
          )}
        </div>
      </Form>
    </Modal>
  );
};

export default ModelForm;
