#!/bin/bash
# ============================================
#  New API 令牌连通性测试
#  用法: bash test-token.sh
# ============================================

# ========== 配置区域（修改这里，或通过环境变量传入） ==========
BASE_URL="${BASE_URL:-http://47.251.10.7:3001}"   # API 地址（不带 /v1）
API_KEY="${API_KEY:-sk-你的令牌}"                    # 替换成你的令牌
MODEL="${MODEL:-claude-fable-5}"                   # 可选: claude-fable-5, claude-opus-4-6
# ==============================================================

GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo "========================================"
echo "  New API 令牌连通性测试"
echo "========================================"
echo -e "  地址: ${CYAN}${BASE_URL}${NC}"
echo -e "  令牌: ${CYAN}${API_KEY:0:10}...${API_KEY: -4}${NC}"
echo -e "  模型: ${CYAN}${MODEL}${NC}"
echo "========================================"
echo ""

# ---------- 1. 网络连通 ----------
echo "[1/4] 测试网络连通..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${BASE_URL}/v1/models" \
  -H "Authorization: Bearer ${API_KEY}" 2>/dev/null)
if [ "$HTTP_CODE" = "200" ]; then
    echo -e "  ${GREEN}✓ 网络正常${NC}"
else
    echo -e "  ${RED}✗ 连接失败 (HTTP ${HTTP_CODE})${NC}"
    echo "  检查: 地址是否正确？防火墙是否放行 3001 端口？"
    exit 1
fi
echo ""

# ---------- 2. 令牌认证 & 可用模型 ----------
echo "[2/4] 验证令牌..."
MODELS=$(curl -s --max-time 10 "${BASE_URL}/v1/models" \
  -H "Authorization: Bearer ${API_KEY}" 2>/dev/null)
if echo "$MODELS" | grep -q '"id"'; then
    echo -e "  ${GREEN}✓ 令牌有效${NC}"
    echo "  可用模型:"
    echo "$MODELS" | python3 -c "
import sys,json
for m in json.load(sys.stdin).get('data',[]):
    print(f\"    - {m['id']}\")
" 2>/dev/null || echo "$MODELS" | grep -o '"id":"[^"]*"' | sed 's/"id":"/ /;s/"$//'
else
    echo -e "  ${RED}✗ 令牌无效或无权限${NC}"
    echo "  响应: $(echo "$MODELS" | head -c 200)"
    exit 1
fi
echo ""

# ---------- 3. 普通对话 ----------
echo "[3/4] 测试普通对话..."
CHAT=$(curl -s --max-time 60 "${BASE_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${MODEL}\",
    \"messages\": [{\"role\": \"user\", \"content\": \"请只回复两个字：成功\"}],
    \"max_tokens\": 20
  }" 2>/dev/null)
if echo "$CHAT" | grep -q '"choices"'; then
    REPLY=$(echo "$CHAT" | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['content'].strip())" 2>/dev/null)
    echo -e "  ${GREEN}✓ 对话正常${NC}"
    echo "  模型回复: ${REPLY}"
else
    echo -e "  ${RED}✗ 对话失败${NC}"
    echo "  错误: $(echo "$CHAT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error',{}).get('message','未知'))" 2>/dev/null)"
    exit 1
fi
echo ""

# ---------- 4. 工具调用（Function Calling） ----------
echo "[4/4] 测试工具调用（Function Calling）..."
TOOL_CALL=$(curl -s --max-time 60 "${BASE_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${MODEL}\",
    \"messages\": [{\"role\": \"user\", \"content\": \"北京现在几度？\"}],
    \"tools\": [{
      \"type\": \"function\",
      \"function\": {
        \"name\": \"get_weather\",
        \"description\": \"获取指定城市的天气\",
        \"parameters\": {
          \"type\": \"object\",
          \"properties\": {\"city\": {\"type\": \"string\"}},
          \"required\": [\"city\"]
        }
      }
    }],
    \"max_tokens\": 200
  }" 2>/dev/null)

if echo "$TOOL_CALL" | grep -q '"tool_calls"'; then
    FUNC_NAME=$(echo "$TOOL_CALL" | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['tool_calls'][0]['function']['name'])" 2>/dev/null)
    FUNC_ARGS=$(echo "$TOOL_CALL" | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['tool_calls'][0]['function']['arguments'])" 2>/dev/null)
    TOOL_ID=$(echo "$TOOL_CALL" | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['tool_calls'][0]['id'])" 2>/dev/null)
    echo -e "  ${GREEN}✓ 工具调用正常${NC}"
    echo "  函数: ${FUNC_NAME}(${FUNC_ARGS})"

    # 4b. 回传工具结果
    echo "  回传工具结果..."
    TOOL_RESULT=$(curl -s --max-time 60 "${BASE_URL}/v1/chat/completions" \
      -H "Authorization: Bearer ${API_KEY}" \
      -H "Content-Type: application/json" \
      -d "$(python3 -c "
import json
print(json.dumps({
    'model': '${MODEL}',
    'messages': [
        {'role': 'user', 'content': '北京现在几度？'},
        {'role': 'assistant', 'content': '', 'tool_calls': [{'id': '${TOOL_ID}', 'type': 'function', 'function': {'name': '${FUNC_NAME}', 'arguments': '${FUNC_ARGS}'}}]},
        {'role': 'tool', 'tool_call_id': '${TOOL_ID}', 'content': '北京：32°C，晴天'}
    ],
    'tools': [{'type': 'function', 'function': {'name': 'get_weather', 'description': '获取指定城市的天气', 'parameters': {'type': 'object', 'properties': {'city': {'type': 'string'}}, 'required': ['city']}}}],
    'max_tokens': 200
}))" 2>/dev/null)" 2>/dev/null)

    if echo "$TOOL_RESULT" | grep -q '"choices"'; then
        FINAL=$(echo "$TOOL_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['content'].strip())" 2>/dev/null)
        echo -e "  ${GREEN}✓ 工具结果回传正常${NC}"
        echo "  最终回复: ${FINAL}"
    else
        echo -e "  ${RED}✗ 工具结果回传失败${NC}"
        echo "  错误: $(echo "$TOOL_RESULT" | head -c 300)"
    fi
else
    echo -e "  ${RED}✗ 工具调用失败${NC}"
    echo "  错误: $(echo "$TOOL_CALL" | head -c 300)"
fi

echo ""
echo "========================================"
echo "  测试完成"
echo "========================================"
echo ""

# ========== 各客户端配置参考 ==========
cat << 'EOF'
📋 客户端配置参考
────────────────────────────────

通用配置:
  API 地址:  http://47.251.10.7:3001/v1
  API Key:   （你的令牌，sk-开头）
  模型:      claude-fable-5 或 claude-opus-4-6
  接口格式:  OpenAI 兼容

Cherry Studio / NextChat / LobeChat:
  Provider 类型: OpenAI 兼容
  API Base URL:  http://47.251.10.7:3001/v1
  API Key:       sk-xxx
  模型名称:     手动填 claude-fable-5

Cursor / Continue / Cline:
  类型:         OpenAI Compatible
  Base URL:     http://47.251.10.7:3001/v1
  API Key:      sk-xxx
  Model:        claude-fable-5

Python (openai 库):
  from openai import OpenAI
  client = OpenAI(
      base_url="http://47.251.10.7:3001/v1",
      api_key="sk-xxx"
  )
  resp = client.chat.completions.create(
      model="claude-fable-5",
      messages=[{"role": "user", "content": "你好"}]
  )
  print(resp.choices[0].message.content)

curl:
  curl http://47.251.10.7:3001/v1/chat/completions \
    -H "Authorization: Bearer sk-xxx" \
    -H "Content-Type: application/json" \
    -d '{"model":"claude-fable-5","messages":[{"role":"user","content":"你好"}]}'

⚠️ 注意事项:
  - 地址末尾不要多加斜杠（/v1 不是 /v1/）
  - 接口格式选 OpenAI 兼容，不要选 Anthropic/Claude 原生
  - 如果客户端有"自定义端点"或"第三方API"选项，选那个
EOF
