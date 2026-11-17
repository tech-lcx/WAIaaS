---
id: "defi-18"
title: "LCX Liberty DEX Swap (ETH -> USDC)"
category: "defi"
auth: "session"
network: ["base-mainnet"]
requires_funds: true
estimated_cost_usd: "0.05"
risk_level: "medium"
tags: ["defi", "swap", "lcx-liberty-dex", "evm", "dex"]
---

# LCX Liberty DEX Swap (ETH -> USDC)

## Metadata
- **ID**: defi-18
- **Category**: defi
- **Network**: base-mainnet
- **Requires Funds**: Yes
- **Estimated Cost**: ~$0.05 (Base)
- **Risk Level**: medium -- 실제 메인넷 토큰 스왑, 가스비 변동 가능

## Prerequisites
- [ ] WAIaaS 데몬 실행 중 (`http://localhost:3100`)
- [ ] 세션 토큰 보유 (sessionAuth)
- [ ] Base Mainnet EVM 지갑 보유
- [ ] ETH 보유 (스왑 금액 + 가스비, 최소 0.001 ETH)
- [ ] 관리자가 `actions.lcx_liberty_swap_enabled = true` 설정 및 LCX Liberty DEX API 키 등록 완료 (기본 비활성)

## Scenario Steps

### Step 1: 잔액 조회
**Action**: Base Mainnet에서 ETH 잔액을 조회한다.
```bash
curl -s "http://localhost:3100/v1/wallet/balance?walletId=<WALLET_ID>&network=base-mainnet" \
  -H 'Authorization: Bearer <session-token>'
```
**Expected**: 200 OK, ETH 잔액이 반환된다
**Check**: ETH 잔액이 0.001 이상인지 확인

### Step 2: LCX Liberty DEX 스왑 Dry-run
**Action**: 0.0005 ETH -> USDC 스왑을 dryRun으로 실행하여 정책 판정과 예상 결과를 확인한다.
```bash
curl -s -X POST "http://localhost:3100/v1/actions/lcx_liberty_swap/swap?dryRun=true" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <session-token>' \
  -d '{
    "walletId": "<WALLET_ID>",
    "network": "base-mainnet",
    "params": {
      "sellToken": "0x0000000000000000000000000000000000000000",
      "buyToken": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "sellAmount": "500000000000000",
      "chainId": 8453
    }
  }'
```
**Expected**: 200 OK, `policy`(tier, allowed), `simulation` 결과가 반환된다
**Check**: `policy.allowed`가 true인지, 대상 컨트랙트가 라우터 `0x0000000000b1ae06c96aB73FF4360d7AeAaB56F0`인지 확인

### Step 3: 사용자 승인
**Action**: 스왑 조건을 사용자에게 표시하고 승인을 요청한다.
- 스왑: 0.0005 ETH -> USDC (Base)
- 라우터: `0x0000000000b1ae06c96aB73FF4360d7AeAaB56F0`
- USDC contract: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

**Check**: 사용자가 스왑 조건을 확인하고 승인

### Step 4: 실제 스왑 실행
**Action**: 사용자 승인 후 실제 스왑을 실행한다.
```bash
curl -s -X POST http://localhost:3100/v1/actions/lcx_liberty_swap/swap \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <session-token>' \
  -d '{
    "walletId": "<WALLET_ID>",
    "network": "base-mainnet",
    "params": {
      "sellToken": "0x0000000000000000000000000000000000000000",
      "buyToken": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "sellAmount": "500000000000000",
      "chainId": 8453
    }
  }'
```
**Expected**: 201 Created, 트랜잭션 ID가 반환된다 (네이티브 매도이므로 approve 없이 1건)
**Check**: `id`, `status` 필드 기록

### Step 5: 트랜잭션 상태 확인
**Action**: 트랜잭션 컨펌 상태를 확인한다.
```bash
curl -s http://localhost:3100/v1/transactions/<TX_ID> \
  -H 'Authorization: Bearer <session-token>'
```
**Expected**: 트랜잭션 상태가 `CONFIRMED`로 전환된다
**Check**: `status` 필드 확인. Base ~2초 블록타임, 수십 초 내 컨펌 기대

### Step 6: 잔액 재확인
**Action**: 스왑 후 잔액을 재조회하여 ETH 감소, USDC 증가를 확인한다.
```bash
curl -s "http://localhost:3100/v1/wallet/balance?walletId=<WALLET_ID>&network=base-mainnet" \
  -H 'Authorization: Bearer <session-token>'
```
**Expected**: ETH 잔액이 0.0005 ETH + 가스비만큼 감소, USDC 잔액이 증가
**Check**: USDC 증가분 확인

## Verification
- [ ] ETH 잔액 조회 성공 (200 응답)
- [ ] Dry-run 성공 (정책 판정 반환, 대상 = LCX Liberty DEX 라우터)
- [ ] 사용자 승인 완료
- [ ] 실제 스왑 트랜잭션 생성 성공 (id 반환)
- [ ] 트랜잭션 컨펌 완료 (status: CONFIRMED)
- [ ] 스왑 후 ETH 감소, USDC 증가 확인

## Estimated Cost
| Item | Network | Estimated Gas | USD |
|------|---------|---------------|-----|
| LCX Liberty DEX swap (ETH sell) | base-mainnet | ~200,000 | ~$0.05 |
| **Total** | | | **~$0.05** |

> **Note**: ERC-20 매도 시에는 매도 수량과 정확히 같은 금액의 approve 트랜잭션이 먼저 실행된다 (무제한 approve 없음).

## Troubleshooting
| Symptom | Cause | Resolution |
|---------|-------|------------|
| `API_KEY_REQUIRED` | API 키 미등록 | Admin UI > DeFi에서 LCX Liberty DEX API 키 등록 |
| `ACTION_NOT_FOUND` | 프로바이더 비활성 (기본값) | `actions.lcx_liberty_swap_enabled = true` 설정 |
| `ACTION_RESOLVE_FAILED` (`no_route`) | 해당 토큰 쌍의 경로 없음 | 다른 토큰 쌍 또는 금액으로 재시도 |
| `ACTION_RESOLVE_FAILED` (`Unsupported chain ID`) | 지원하지 않는 체인 | 1, 10, 137, 999, 8453, 42161 중 하나 사용 |
| `ACTION_RESOLVE_FAILED` (`QUOTE_EXPIRED`) | 견적 만료 (120초) | 요청을 다시 실행 |
