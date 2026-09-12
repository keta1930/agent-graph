import { memo } from 'react';
import { Typography, Tag, Space } from 'antd';
import SmartMarkdown from './SmartMarkdown';
import { useT } from '../../../i18n/hooks';

const { Text } = Typography;

const GraphSummary = memo(function GraphSummary({ executionChain, finalResult }: { executionChain?: string[][]; finalResult?: string }) {
  const t = useT();
  if (!executionChain) return null;
  return (
    <div style={{
      marginBottom: '24px',
      padding: '20px 24px',
      background: 'rgba(255, 255, 255, 0.85)',
      border: '1px solid rgba(139, 115, 85, 0.15)',
      borderRadius: '8px',
      boxShadow: '0 2px 8px rgba(139, 115, 85, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.8)',
    }}>
      <div style={{
        marginBottom: '20px',
        paddingBottom: '12px',
        borderBottom: '1px solid rgba(139, 115, 85, 0.1)',
      }}>
        <Text strong style={{
          fontSize: '16px',
          color: '#2d2d2d',
          fontWeight: 600,
          letterSpacing: '0.5px',
        }}>
          {t('pages.chatSystem.messageDisplay.executionSummary')}
        </Text>
      </div>

      <div style={{ marginBottom: '16px' }}>
        <Text style={{
          fontSize: '13px',
          color: 'rgba(45, 45, 45, 0.65)',
          fontWeight: 500,
          marginBottom: '8px',
          display: 'block',
        }}>
          {t('pages.chatSystem.messageDisplay.executionChain')}
        </Text>
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}>
          {executionChain.map((level, index) => (
            <div key={index} style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              padding: '10px 14px',
              background: 'rgba(245, 243, 240, 0.6)',
              borderRadius: '6px',
              border: '1px solid rgba(139, 115, 85, 0.1)',
            }}>
              <Tag style={{
                background: 'rgba(160, 130, 109, 0.12)',
                color: '#a0826d',
                border: '1px solid rgba(160, 130, 109, 0.25)',
                borderRadius: '6px',
                fontWeight: 500,
                padding: '4px 12px',
                fontSize: '12px',
                margin: 0,
              }}>
                {t('pages.chatSystem.messageDisplay.level')} {index}
              </Tag>
              <Space wrap size={8}>
                {level.map(nodeName => (
                  <Tag key={nodeName} style={{
                    background: 'rgba(184, 88, 69, 0.08)',
                    color: '#b85845',
                    border: '1px solid rgba(184, 88, 69, 0.2)',
                    borderRadius: '6px',
                    fontWeight: 500,
                    padding: '4px 10px',
                    fontSize: '12px',
                    margin: 0,
                  }}>
                    {nodeName}
                  </Tag>
                ))}
              </Space>
            </div>
          ))}
        </div>
      </div>

      {finalResult && (
        <div style={{
          marginTop: '20px',
          paddingTop: '16px',
          borderTop: '1px solid rgba(139, 115, 85, 0.1)',
        }}>
          <Text style={{
            fontSize: '13px',
            color: 'rgba(45, 45, 45, 0.65)',
            fontWeight: 500,
            marginBottom: '8px',
            display: 'block',
          }}>
            {t('pages.chatSystem.messageDisplay.finalResult')}
          </Text>
          <div style={{
            margin: 0,
            padding: '12px 14px',
            background: 'rgba(245, 243, 240, 0.6)',
            borderRadius: '6px',
            border: '1px solid rgba(139, 115, 85, 0.1)',
            fontSize: '14px',
            color: '#2d2d2d',
            lineHeight: '1.7',
          }}>
            <SmartMarkdown content={finalResult} />
          </div>
        </div>
      )}
    </div>
  );
});

export default GraphSummary;
