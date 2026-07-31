'use strict';

const OUTCOME = Symbol('tool-outcome');

function success(text, data = {}) {
  return { [OUTCOME]: true, ok: true, text: String(text || ''), data };
}

function failure(code, message, options = {}) {
  const hint = options.hint || '';
  const text = options.text || `${message}${hint ? `\n\n${hint}` : ''}`;
  return {
    [OUTCOME]: true,
    ok: false,
    text,
    code,
    message,
    hint,
    details: options.details || {},
    isError: options.isError === true,
  };
}

function classifyException(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP 503/.test(message)) {
    return {
      code: 'UPSTREAM_BLOCKED',
      hint: 'rule.dongguk.edu가 이 IP를 차단했습니다. 국내 IP(가정/캠퍼스 망)에서 실행하세요.',
    };
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|network|timeout/i.test(message)) {
    return { code: 'UPSTREAM_UNAVAILABLE', hint: '네트워크 연결을 확인한 뒤 다시 시도하세요.' };
  }
  if (/파싱|응답 형식|본문을 가져올 수 없습니다|HWP/i.test(message)) {
    return { code: 'UPSTREAM_FORMAT_CHANGED', hint: '원문 또는 사이트 응답 형식이 변경되었는지 확인하세요.' };
  }
  return { code: 'INTERNAL_ERROR', hint: '서버 로그와 원문 사이트 응답을 확인하세요.' };
}

function serializeOutcome(tool, value) {
  const outcome = value && value[OUTCOME]
    ? value
    : success(typeof value === 'string' ? value : JSON.stringify(value), {});
  const structuredContent = outcome.ok
    ? { ok: true, tool, data: outcome.data || {} }
    : {
        ok: false,
        tool,
        error: {
          code: outcome.code,
          message: outcome.message,
          hint: outcome.hint || '',
          details: outcome.details || {},
        },
      };
  return {
    content: [{ type: 'text', text: outcome.text }],
    structuredContent,
    ...(outcome.isError ? { isError: true } : {}),
  };
}

function serializeException(tool, error) {
  const { code, hint } = classifyException(error);
  const message = error instanceof Error ? error.message : String(error);
  return serializeOutcome(tool, failure(code, message, {
    hint,
    text: `❌ [${code}] ${message}\n\n${hint}`,
    isError: true,
  }));
}

const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '도구 실행 성공 여부' },
    tool: { type: 'string', description: '실행한 도구 이름' },
    data: { type: 'object', description: '성공 시 구조화 결과' },
    error: {
      type: 'object',
      description: '실패 시 구조화 오류',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        hint: { type: 'string' },
        details: { type: 'object' },
      },
      required: ['code', 'message'],
    },
  },
  required: ['ok', 'tool'],
};

module.exports = {
  success,
  failure,
  serializeOutcome,
  serializeException,
  TOOL_OUTPUT_SCHEMA,
};
