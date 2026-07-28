// RFP 자동분석 백엔드 — Cloudflare Worker
// 업로드된 RFP PDF를 Claude API로 보내 사업명·마감일정·요구사항·필요 첨부서류를 구조화 추출합니다.
//
// [배포 방법]
// 1. https://dash.cloudflare.com 접속 → Workers & Pages → Create → "Create Worker"
// 2. 아무 이름이나 지정(예: rfp-analyzer) 후 생성
// 3. 편집 화면에서 기본 코드를 지우고 이 파일 내용 전체를 붙여넣기 → Deploy
// 4. Settings → Variables and Secrets → "Add" → 이름 ANTHROPIC_API_KEY, 값에 발급받은 API 키 입력 → Encrypt 체크 → Save
// 5. 배포된 주소(예: https://rfp-analyzer.<your-subdomain>.workers.dev)를
//    레몬헬스케어 앱의 "전체 관리 → RFP 자동분석 연동"에 붙여넣기

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    if (request.method !== 'POST') {
      return json({ error: 'POST 요청만 지원합니다.' }, 405, corsHeaders);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: '서버에 ANTHROPIC_API_KEY가 설정되어 있지 않습니다. Cloudflare Worker Settings에서 Secret을 등록하세요.' }, 500, corsHeaders);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: '요청 본문이 올바른 JSON이 아닙니다.' }, 400, corsHeaders);
    }

    const pdfBase64 = body && body.pdfBase64;
    if (!pdfBase64 || typeof pdfBase64 !== 'string') {
      return json({ error: 'pdfBase64 필드가 필요합니다.' }, 400, corsHeaders);
    }
    // 대략적인 크기 가드(원본 PDF 기준 약 30MB 초과 시 base64는 더 커짐) — 필요시 조정
    if (pdfBase64.length > 45 * 1024 * 1024) {
      return json({ error: 'PDF 용량이 너무 큽니다(약 30MB 이하 권장).' }, 413, corsHeaders);
    }

    const extractTool = {
      name: 'extract_rfp',
      description: 'RFP(제안요청서) 문서에서 핵심 정보를 구조화하여 추출한다.',
      input_schema: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: '사업명(공고문 제목 기준)' },
          estimatedBudget: { type: ['number', 'null'], description: '사업 예산 금액(원). 문서에 명시된 숫자만, 추정 불가하면 null' },
          preAnnounceDate: { type: ['string', 'null'], description: '사전공고일(YYYY-MM-DD). 문서에 없으면 null' },
          announceDate: { type: ['string', 'null'], description: '본공고일(YYYY-MM-DD). 문서에 없으면 null' },
          proposalDeadline: { type: ['string', 'null'], description: '제안서 제출 마감일(YYYY-MM-DD). 문서에 없으면 null' },
          proposalPresentationDate: { type: ['string', 'null'], description: '제안발표(PT) 예정일(YYYY-MM-DD). 문서에 없으면 null' },
          resultAnnounceDate: { type: ['string', 'null'], description: '결과(우선협상대상자) 발표 예정일(YYYY-MM-DD). 문서에 없으면 null' },
          requirementsSummary: { type: 'string', description: '핵심 요구사항을 불릿(줄바꿈 구분)으로 정리한 요약문' },
          requiredAttachments: { type: 'array', items: { type: 'string' }, description: '제안서 제출 시 필요한 첨부서류 목록' },
          bizTypeGuess: { type: 'string', enum: ['SI', 'SM', 'RND'], description: '사업 성격 추정: 신규 구축=SI, 유지보수/운영=SM, 연구개발과제=RND' }
        },
        required: ['projectName', 'requirementsSummary', 'requiredAttachments', 'bizTypeGuess']
      }
    };

    let anthropicRes;
    try {
      anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 4096,
          tools: [extractTool],
          tool_choice: { type: 'tool', name: 'extract_rfp' },
          messages: [{
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
              { type: 'text', text: '이 RFP(제안요청서) 문서를 분석해서 extract_rfp 도구로 정보를 추출해줘. 문서에 명시되지 않은 값은 추측하지 말고 null 또는 빈 값으로 두어라.' }
            ]
          }]
        })
      });
    } catch (e) {
      return json({ error: 'Claude API 호출 중 네트워크 오류: ' + String(e) }, 502, corsHeaders);
    }

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      // PDF 문서 지원이 계정/API 버전에 따라 베타 헤더가 필요할 수 있습니다.
      // 아래와 같은 오류가 보이면 fetch 호출의 headers에
      // 'anthropic-beta': 'pdfs-2024-09-25' 를 추가해보세요.
      return json({ error: 'Claude API 오류(' + anthropicRes.status + '): ' + errText }, 502, corsHeaders);
    }

    const data = await anthropicRes.json();
    const toolUse = (data.content || []).find(function (b) { return b.type === 'tool_use'; });
    if (!toolUse) {
      return json({ error: 'AI가 구조화된 결과를 반환하지 않았습니다. 문서가 텍스트를 포함한 PDF인지 확인하세요(스캔 이미지 PDF는 인식률이 낮을 수 있습니다).' }, 502, corsHeaders);
    }

    return json({ result: toolUse.input }, 200, corsHeaders);
  }
};

function json(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders)
  });
}
