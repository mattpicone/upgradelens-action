"""Autonomous Python Bazaar/direct-MCP buyer using x402 v2.

Install: pip install "x402[mcp]" mcp eth-account
Search is free. Payment is capped in code to one exact $0.01 Base-USDC call.
"""

import asyncio
import json
import os
from typing import Any

from eth_account import Account
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from x402 import x402ClientSync
from x402.extensions.payment_identifier import append_payment_identifier_to_extensions
from x402.mechanisms.evm import EthAccountSigner
from x402.mechanisms.evm.exact.register import register_exact_evm_client
from x402.mcp import MCPToolResult, x402MCPClient

BAZAAR = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/mcp"
DIRECT = "https://upgradelens.mattpicone.workers.dev/mcp"
BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
REQUEST = {"ecosystem": "pypi", "package": "django", "current_version": "4.2.11", "target_version": "5.1.1", "runtime": {"python": "3.12"}, "detail": "compact"}
INTENT = "Review whether this exact PyPI dependency upgrade is safe and return a cited migration plan"


class Adapter:
    def __init__(self, session: ClientSession):
        self.session = session

    async def call_tool(self, params: dict[str, Any], **_: Any) -> MCPToolResult:
        result = await self.session.call_tool(params["name"], params.get("arguments", {}), meta=params.get("_meta"))
        content = [{"type": getattr(item, "type", "text"), "text": getattr(item, "text", str(item))} for item in result.content]
        return MCPToolResult(content=content, is_error=getattr(result, "isError", False), meta=dict(result.meta or {}))

    async def list_tools(self) -> Any:
        return await self.session.list_tools()


class PaymentIdentifierExtension:
    key = "payment-identifier"
    hooks = None
    transport_hooks = None

    def enrich_payment_payload(self, payload: Any, required: Any) -> Any:
        extensions = dict(payload.extensions or required.extensions or {})
        append_payment_identifier_to_extensions(extensions)
        return payload.model_copy(update={"extensions": extensions})


def structured(result: Any) -> dict[str, Any]:
    for item in result.content:
        if item.get("type") == "text":
            try:
                value = json.loads(item["text"])
                if isinstance(value, dict):
                    return value
            except json.JSONDecodeError:
                pass
    raise RuntimeError("Tool returned no structured JSON")


def entries(value: dict[str, Any]) -> list[dict[str, Any]]:
    return list(value.get("resources", [])) + list(value.get("items", [])) + list(value.get("tools", []))


def discovered_tool(entry: dict[str, Any]) -> str | None:
    required = entry.get("_meta", {}).get("x402/payment-required", entry)
    return required.get("extensions", {}).get("bazaar", {}).get("info", {}).get("input", {}).get("toolName") or entry.get("toolName")


def validate_citations(result: dict[str, Any]) -> None:
    citations = result.get("citations") or result.get("evidence") or []
    if not citations or any(not item.get("source_url", "").startswith("https://") for item in citations):
        raise RuntimeError("Missing or unsafe citations; do not act on this result")


async def main() -> None:
    key = os.getenv("EVM_PRIVATE_KEY")
    payment = x402ClientSync()
    if key:
        register_exact_evm_client(payment, EthAccountSigner(Account.from_key(key)))
    payment.register_extension(PaymentIdentifierExtension())
    endpoint = DIRECT if os.getenv("DIRECT_MCP") != "false" else BAZAAR
    paid = False

    async with streamablehttp_client(endpoint) as streams:
        read_stream, write_stream = streams[0], streams[1]
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            adapter = Adapter(session)

            def allow(context: Any) -> bool:
                nonlocal paid
                required = context.payment_required.accepts[0] if len(context.payment_required.accepts) == 1 else None
                allowed = bool(key) and not paid and context.tool_name in {"proxy_tool_call", "review_dependency_upgrade"} and required and required.scheme == "exact" and required.network == "eip155:8453" and required.amount == "10000" and required.asset.lower() == BASE_USDC
                if allowed:
                    paid = True
                return bool(allowed)

            buyer = x402MCPClient(adapter, payment, auto_payment=bool(key), on_payment_requested=allow)
            async def call_tool(name: str, arguments: dict[str, Any]) -> Any:
                if key:
                    return await buyer.call_tool(name, arguments)
                return await adapter.call_tool({"name": name, "arguments": arguments})

            if endpoint == DIRECT:
                listed = await adapter.list_tools()
                if not any(tool.name == "review_dependency_upgrade" for tool in listed.tools):
                    raise RuntimeError("Review tool not found on the direct endpoint")
                result = structured(await call_tool("review_dependency_upgrade", REQUEST))
            else:
                search = structured(await call_tool("search_resources", {"query": INTENT}))
                match = next((item for item in entries(search) if discovered_tool(item) == "review_dependency_upgrade"), None)
                if not match:
                    raise RuntimeError("No exact dependency-upgrade review resource found in Bazaar")
                result = structured(await call_tool("proxy_tool_call", {"toolName": discovered_tool(match), "parameters": REQUEST}))
            if result.get("x402Version") == 2 or result.get("error"):
                raise RuntimeError(result.get("error", {}).get("message", "Free evaluation is exhausted. Configure an authorized EVM_PRIVATE_KEY to enable the capped $0.01 payment, then retry."))
            validate_citations(result)
            print(json.dumps(result, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
