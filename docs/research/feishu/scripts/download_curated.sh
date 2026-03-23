#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="docs/research/feishu"
RAW_DIR="$BASE_DIR/raw"
DL_DIR="$BASE_DIR/downloaded"
mkdir -p "$RAW_DIR" "$DL_DIR"

JSON_FILE="$RAW_DIR/server_side_api_list.json"
if [ ! -f "$JSON_FILE" ]; then
  env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy \
    curl -L -sS 'https://open.feishu.cn/api/tools/server-side-api/list' -o "$JSON_FILE"
fi

CURATED_TSV="$BASE_DIR/curated_endpoints.tsv"

jq -r '
  .data.apis[]
  | select(
      .url == "POST:/open-apis/auth/v3/tenant_access_token/internal"
      or .url == "GET:/open-apis/drive/v1/files"
      or .url == "POST:/open-apis/drive/v1/files/create_folder"
      or .url == "POST:/open-apis/drive/v1/files/upload_all"
      or .url == "GET:/open-apis/drive/v1/files/:file_token/download"
      or .url == "POST:/open-apis/drive/v1/files/:file_token/copy"
      or .url == "POST:/open-apis/drive/v1/files/:file_token/move"
      or .url == "DELETE:/open-apis/drive/v1/files/:file_token"
      or .url == "GET:/open-apis/drive/v1/permissions/:token/members"
      or .url == "POST:/open-apis/drive/v1/permissions/:token/members"
      or .url == "PUT:/open-apis/drive/v1/permissions/:token/members/:member_id"
      or .url == "DELETE:/open-apis/drive/v1/permissions/:token/members/:member_id"
      or .url == "GET:/open-apis/drive/v2/permissions/:token/public"
      or .url == "PATCH:/open-apis/drive/v2/permissions/:token/public"
      or .url == "POST:/open-apis/docx/v1/documents"
      or .url == "GET:/open-apis/docx/v1/documents/:document_id"
      or .url == "GET:/open-apis/docx/v1/documents/:document_id/raw_content"
      or .url == "GET:/open-apis/docx/v1/documents/:document_id/blocks"
      or .url == "POST:/open-apis/docx/v1/documents/:document_id/blocks/:block_id/children"
      or .url == "PATCH:/open-apis/docx/v1/documents/:document_id/blocks/:block_id"
      or .url == "GET:/open-apis/wiki/v2/spaces"
      or .url == "GET:/open-apis/wiki/v2/spaces/:space_id"
      or .url == "POST:/open-apis/wiki/v2/spaces"
      or .url == "POST:/open-apis/wiki/v2/spaces/:space_id/nodes"
      or .url == "GET:/open-apis/wiki/v2/spaces/get_node"
      or .url == "GET:/open-apis/wiki/v2/spaces/:space_id/nodes"
      or .url == "POST:/open-apis/wiki/v2/spaces/:space_id/nodes/:node_token/move"
      or .url == "POST:/open-apis/suite/docs-api/search/object"
    )
  | [.name, .url, .fullPath, .bizTag] | @tsv
' "$JSON_FILE" > "$CURATED_TSV"

while IFS=$'\t' read -r _name api_url full_path _biz; do
  [ -z "$full_path" ] && continue
  page_url="https://open.feishu.cn${full_path}"
  safe_name=$(echo "$api_url" | sed 's#[/:]#_#g' | sed 's/[^A-Za-z0-9_.-]/_/g')
  out_md="$DL_DIR/${safe_name}.md"

  status=$(env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy \
    curl -L -sS -o /tmp/feishu_doc_tmp -w '%{http_code}' "${page_url}.md" || true)
  if [ "$status" = "200" ] && ! rg -q "This document is not found" /tmp/feishu_doc_tmp; then
    cp /tmp/feishu_doc_tmp "$out_md"
    continue
  fi

  env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy \
    curl -L -sS "$page_url" -o /tmp/feishu_doc_tmp_html || true

  alt_md=$(rg -o 'href="https://open\.feishu\.cn[^"]+\.md[^"]*"' -N /tmp/feishu_doc_tmp_html | head -n1 | sed 's/^href="//' | sed 's/"$//')
  if [ -n "$alt_md" ]; then
    alt_status=$(env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy \
      curl -L -sS -o /tmp/feishu_doc_tmp -w '%{http_code}' "$alt_md" || true)
    if [ "$alt_status" = "200" ] && ! rg -q "This document is not found" /tmp/feishu_doc_tmp; then
      cp /tmp/feishu_doc_tmp "$out_md"
      continue
    fi
  fi
done < "$CURATED_TSV"

rm -f /tmp/feishu_doc_tmp /tmp/feishu_doc_tmp_html
echo "done: $(wc -l < "$CURATED_TSV" | tr -d ' ') endpoints"

