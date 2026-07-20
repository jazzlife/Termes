from pathlib import Path


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one patch target, found {count}")
    path.write_text(text.replace(old, new, 1))


transport = Path("/opt/hermes/agent/transports/codex_app_server.py")
replace_once(
    transport,
    "        timeout: float = 10.0,\n",
    '        timeout: float = float(os.environ.get("HERMES_CODEX_APP_SERVER_INIT_TIMEOUT_SECONDS", "90")),\n',
    "Codex app-server initialize timeout",
)
replace_once(
    transport,
    "import queue\nimport subprocess\n",
    "import queue\nimport signal\nimport subprocess\n",
    "Codex app-server signal import",
)
replace_once(
    transport,
    "            env=spawn_env,\n        )\n",
    "            env=spawn_env,\n            start_new_session=True,\n        )\n",
    "Codex app-server process group",
)
replace_once(
    transport,
    """        try:
            self._proc.terminate()
            self._proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                self._proc.kill()
                self._proc.wait(timeout=1.0)
            except Exception:
                pass
""",
    """        try:
            os.killpg(os.getpgid(self._proc.pid), signal.SIGTERM)
        except Exception:
            try:
                self._proc.terminate()
            except Exception:
                pass
        try:
            self._proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(self._proc.pid), signal.SIGKILL)
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
            try:
                self._proc.wait(timeout=1.0)
            except Exception:
                pass
""",
    "Codex app-server process-group close",
)

runtime = Path("/opt/hermes/agent/codex_runtime.py")
replace_once(runtime, "import logging\nimport os\n", "import json\nimport logging\nimport os\n", "Codex runtime JSON import")
replace_once(
    runtime,
    """    return {
        "final_response": turn.final_text,
""",
    """    try:
        agent._codex_session.close()
    except Exception:
        pass
    agent._codex_session = None

    return {
        "final_response": turn.final_text,
""",
    "Codex runtime post-turn close",
)
replace_once(
    runtime,
    """        return {
            "final_response": (
                f"Codex app-server turn failed: {exc}. "
                f"Fall back to default runtime with `/codex-runtime auto`."
            ),
            "messages": messages,
            "api_calls": 0,
            "completed": False,
            "partial": True,
            "error": str(exc),
        }
""",
    """        return {
            "final_response": "",
            "messages": messages,
            "api_calls": 0,
            "completed": False,
            "partial": True,
            "error": str(exc),
        }
""",
    "Codex runtime failure response",
)
replace_once(
    runtime,
    """    # Background review fork — same cadence + signature as the default
    # path (line ~15449). Only fires when a trigger actually tripped AND
    # we have a real final response.
""",
    """    should_review_memory = False
    should_review_skills = False

    # Background review is disabled on the Codex app-server path. A Termes
    # task returns only after its explicitly orchestrated specialist batch.
""",
    "Codex runtime background review",
)
replace_once(
    runtime,
    """        agent._codex_session = CodexAppServerSession(
            cwd=cwd,
            approval_callback=approval_callback,
            on_event=_on_codex_event,
        )
""",
    """        dynamic_tools = []
        dynamic_tool_callback = None
        if getattr(agent, "_delegate_depth", 0) == 0:
            from model_tools import get_tool_definitions
            from tools.delegate_tool import delegate_task as _delegate_task

            delegate_spec = next(
                (
                    entry.get("function")
                    for entry in get_tool_definitions(
                        quiet_mode=True,
                        skip_tool_search_assembly=True,
                    )
                    if entry.get("function", {}).get("name") == "delegate_task"
                ),
                None,
            )
            if not delegate_spec:
                raise RuntimeError("Hermes delegate_task schema is unavailable")

            delegate_marker = "delegate_task tasks="
            delegate_lines = [
                line[len(delegate_marker):]
                for line in user_message.splitlines()
                if line.startswith(delegate_marker)
            ]
            if len(delegate_lines) > 1:
                raise RuntimeError("Termes received multiple authoritative delegate_task batches")
            if delegate_lines:
                termes_delegate_tasks = json.loads(delegate_lines[0])
                if not isinstance(termes_delegate_tasks, list) or not termes_delegate_tasks:
                    raise RuntimeError("Termes delegate_task batch is empty or invalid")
                delegate_invoked = False

                dynamic_tools = [{
                    "type": "function",
                    "name": "delegate_task",
                    "description": delegate_spec.get("description") or "Delegate specialist work",
                    "inputSchema": delegate_spec.get("parameters") or {
                        "type": "object",
                        "properties": {},
                    },
                }]

                def _run_delegate_dynamic_tool(arguments: dict) -> str:
                    nonlocal delegate_invoked
                    if delegate_invoked:
                        raise RuntimeError("Termes delegate_task batch was already executed")
                    delegate_invoked = True
                    return _delegate_task(
                        tasks=termes_delegate_tasks,
                        background=False,
                        parent_agent=agent,
                    )

                dynamic_tool_callback = _run_delegate_dynamic_tool

        agent._codex_session = CodexAppServerSession(
            cwd=cwd,
            approval_callback=approval_callback,
            on_event=_on_codex_event,
            developer_instructions=(
                getattr(agent, "ephemeral_system_prompt", "")
                or getattr(agent, "_cached_system_prompt", "")
                or ""
            ),
            dynamic_tools=dynamic_tools,
            dynamic_tool_callback=dynamic_tool_callback,
        )
""",
    "Codex runtime synchronous Hermes delegation bridge",
)

session = Path("/opt/hermes/agent/transports/codex_app_server_session.py")
replace_once(
    session,
    """import logging
import os
import threading
""",
    """import json
import logging
import os
import threading
import urllib.error
import urllib.request
""",
    "Codex app-server external auth imports",
)
replace_once(
    session,
    """        approval_callback: Optional[Callable[..., str]] = None,
        on_event: Optional[Callable[[dict], None]] = None,
        request_routing: Optional[_ServerRequestRouting] = None,
""",
    """        approval_callback: Optional[Callable[..., str]] = None,
        on_event: Optional[Callable[[dict], None]] = None,
        developer_instructions: str = "",
        dynamic_tools: Optional[list[dict]] = None,
        dynamic_tool_callback: Optional[Callable[[dict], str]] = None,
        request_routing: Optional[_ServerRequestRouting] = None,
""",
    "Codex app-server dynamic tool constructor",
)
replace_once(
    session,
    """        self._approval_callback = approval_callback
        self._on_event = on_event  # Display hook (kawaii spinner ticks etc.)
        self._routing = request_routing or _ServerRequestRouting()
""",
    """        self._approval_callback = approval_callback
        self._on_event = on_event  # Display hook (kawaii spinner ticks etc.)
        self._developer_instructions = developer_instructions
        self._dynamic_tools = list(dynamic_tools or [])
        self._dynamic_tool_callback = dynamic_tool_callback
        self._routing = request_routing or _ServerRequestRouting()
""",
    "Codex app-server dynamic tool state",
)
replace_once(
    session,
    """        self._client.initialize(
            client_name="hermes",
            client_title="Hermes Agent",
            client_version=_get_hermes_version(),
        )
""",
    """        self._client.initialize(
            client_name="hermes",
            client_title="Hermes Agent",
            client_version=_get_hermes_version(),
            capabilities={"experimentalApi": True},
        )
""",
    "Codex app-server experimental dynamic tool capability",
)
replace_once(
    session,
    """        # Permission selection is intentionally NOT sent on thread/start.
""",
    """        authority_url = os.environ.get("TERMES_CODEX_AUTHORITY_URL", "").strip()
        authority_token = os.environ.get("TERMES_CODEX_AUTHORITY_TOKEN", "").strip()
        if not authority_url or not authority_token:
            raise RuntimeError("Termes Codex external auth authority is required")
        external_auth = self._request_external_auth_tokens(
            authority_url=authority_url,
            authority_token=authority_token,
            reason=None,
            previous_account_id=None,
        )
        self._client.request(
            "account/login/start",
            {
                "type": "chatgptAuthTokens",
                "accessToken": external_auth["accessToken"],
                "chatgptAccountId": external_auth["chatgptAccountId"],
                "chatgptPlanType": external_auth.get("chatgptPlanType"),
            },
            timeout=30,
        )

        # Permission selection is intentionally NOT sent on thread/start.
""",
    "Codex app-server external auth bootstrap",
)
replace_once(
    session,
    """        params: dict[str, Any] = {"cwd": self._cwd}
        result = self._client.request("thread/start", params, timeout=15)
""",
    """        params: dict[str, Any] = {
            "cwd": self._cwd,
            "approvalPolicy": "never",
            "sandbox": "danger-full-access",
            "developerInstructions": self._developer_instructions,
            "dynamicTools": self._dynamic_tools,
        }
        result = self._client.request("thread/start", params, timeout=15)
""",
    "Codex app-server Termes thread boundary",
)
replace_once(
    session,
    """        if method == "item/commandExecution/requestApproval":
            decision = self._decide_exec_approval(params)
            self._client.respond(rid, {"decision": decision})
""",
    """        if method == "account/chatgptAuthTokens/refresh":
            try:
                refreshed = self._request_external_auth_tokens(
                    authority_url=os.environ["TERMES_CODEX_AUTHORITY_URL"].strip(),
                    authority_token=os.environ["TERMES_CODEX_AUTHORITY_TOKEN"].strip(),
                    reason="unauthorized",
                    previous_account_id=params.get("previousAccountId"),
                )
                self._client.respond(
                    rid,
                    {
                        "accessToken": refreshed["accessToken"],
                        "chatgptAccountId": refreshed["chatgptAccountId"],
                        "chatgptPlanType": refreshed.get("chatgptPlanType"),
                    },
                )
            except Exception as exc:
                logger.exception("Termes external Codex auth refresh failed")
                self._client.respond_error(rid, code=-32001, message=str(exc))
        elif method == "item/tool/call":
            tool_name = params.get("tool") or ""
            if tool_name != "delegate_task" or self._dynamic_tool_callback is None:
                self._client.respond_error(
                    rid, code=-32601, message=f"Unsupported dynamic tool: {tool_name}"
                )
                return
            try:
                output = self._dynamic_tool_callback(params.get("arguments") or {})
                self._client.respond(
                    rid,
                    {
                        "contentItems": [{"type": "inputText", "text": str(output)}],
                        "success": True,
                    },
                )
            except Exception as exc:
                logger.exception("Hermes dynamic delegate_task failed")
                self._client.respond(
                    rid,
                    {
                        "contentItems": [{"type": "inputText", "text": f"delegate_task failed: {exc}"}],
                        "success": False,
                    },
                )
        elif method == "item/commandExecution/requestApproval":
            decision = self._decide_exec_approval(params)
            self._client.respond(rid, {"decision": decision})
""",
    "Codex app-server Hermes dynamic tool dispatch",
)
replace_once(
    session,
    """    def _issue_interrupt(self, turn_id: Optional[str]) -> None:
""",
    """    def _request_external_auth_tokens(
        self,
        *,
        authority_url: str,
        authority_token: str,
        reason: Optional[str],
        previous_account_id: Optional[str],
    ) -> dict[str, Any]:
        request = urllib.request.Request(
            authority_url,
            data=json.dumps({
                "reason": reason,
                "previousAccountId": previous_account_id,
            }).encode("utf-8"),
            headers={
                "authorization": f"Bearer {authority_token}",
                "content-type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"Termes Codex auth authority returned {exc.code}") from exc
        if (
            not isinstance(result, dict)
            or not isinstance(result.get("accessToken"), str)
            or not isinstance(result.get("chatgptAccountId"), str)
        ):
            raise RuntimeError("Termes Codex auth authority returned invalid state")
        return result

    def _issue_interrupt(self, turn_id: Optional[str]) -> None:
""",
    "Codex app-server external auth authority request",
)
replace_once(
    session,
    """            if not self._client.is_alive():
                stderr_blob = "\\n".join(self._client.stderr_tail(60))
                hint = _classify_oauth_failure(stderr_blob)
                if hint is not None:
                    result.error = hint
                else:
                    result.error = self._format_error_with_stderr(
                        "codex app-server subprocess exited unexpectedly",
                        tail_lines=20,
                    )
                result.should_retire = True
                break
""",
    """            if not self._client.is_alive():
                stderr_blob = "\\n".join(self._client.stderr_tail(60))
                hint = _classify_oauth_failure(stderr_blob)
                if hint is not None:
                    result.error = hint
                else:
                    result.error = self._format_error_with_stderr(
                        "codex app-server subprocess exited unexpectedly",
                        tail_lines=20,
                    )
                result.interrupted = True
                result.should_retire = True
                break
""",
    "Codex app-server dead subprocess interrupt",
)
replace_once(
    session,
    """        except TimeoutError:
            logger.warning("turn/interrupt timed out")
""",
    """        except TimeoutError:
            logger.warning("turn/interrupt timed out")
        except Exception as exc:
            logger.debug("turn/interrupt skipped after app-server exit: %s", exc)
""",
    "Codex app-server interrupt exception",
)
replace_once(
    session,
    """                "Codex authentication failed — your ChatGPT/Codex login "
                "looks expired or invalid. Run `codex login` to refresh, "
                "then retry. (Fall back to default runtime with "
                "`/codex-runtime auto` if the issue persists.)"
""",
    """                "Codex authentication failed — your ChatGPT/Codex login "
                "looks expired or invalid. Run `codex login` to refresh, "
                "then retry."
""",
    "Codex OAuth fallback hint",
)
replace_once(
    session,
    "\n        return result\n\n    # ---------- internals ----------\n",
    "\n        self.close()\n        return result\n\n    # ---------- internals ----------\n",
    "Codex app-server final close",
)

auth = Path("/opt/hermes/hermes_cli/auth.py")
replace_once(
    auth,
    """    read_error: Optional[AuthError] = None
    try:
""",
    """    authority_url = os.getenv("TERMES_CODEX_AUTHORITY_URL", "").strip()
    authority_token = os.getenv("TERMES_CODEX_AUTHORITY_TOKEN", "").strip()
    if authority_url or authority_token:
        if not authority_url or not authority_token:
            raise AuthError(
                "Termes external Codex auth authority configuration is incomplete.",
                provider="openai-codex",
                code="termes_external_auth_invalid",
                relogin_required=False,
            )
        return {
            "provider": "openai-codex",
            "base_url": os.getenv("HERMES_CODEX_BASE_URL", "").strip().rstrip("/") or DEFAULT_CODEX_BASE_URL,
            "api_key": "termes-external-auth-managed",
            "source": "termes_external_auth",
            "last_refresh": None,
            "auth_mode": "chatgptAuthTokens",
        }

    read_error: Optional[AuthError] = None
    try:
""",
    "Hermes external Codex auth readiness",
)

runtime_provider = Path("/opt/hermes/hermes_cli/runtime_provider.py")
replace_once(
    runtime_provider,
    """                "provider": "openai-codex",
                "api_mode": "codex_responses",
                "base_url": creds.get("base_url", "").rstrip("/"),
""",
    """                "provider": "openai-codex",
                "api_mode": _maybe_apply_codex_app_server_runtime(
                    provider="openai-codex",
                    api_mode="codex_responses",
                    model_cfg=model_cfg,
                ),
                "base_url": creds.get("base_url", "").rstrip("/"),
""",
    "Hermes singleton Codex app-server runtime selection",
)

gateway = Path("/opt/hermes/tui_gateway/server.py")
replace_once(
    gateway,
    '''            "pending_title": title or None,
            "profile_home": str(profile_home) if profile_home is not None else None,
''',
    '''            "pending_title": title or None,
            "auto_title": params.get("auto_title", True) is not False,
            "profile_home": str(profile_home) if profile_home is not None else None,
''',
    "Termes session auto-title option",
)
replace_once(
    gateway,
    '''    # ``profile`` (app-global remote mode): resume a session that lives in another
    # local profile's state.db. None/own profile → the launch profile (unchanged).
    profile = (params.get("profile") or "").strip() or None
    profile_home = _profile_home(profile)
''',
    '''    # ``profile`` (app-global remote mode): resume a session that lives in another
    # local profile's state.db. None/own profile → the launch profile (unchanged).
    profile = (params.get("profile") or "").strip() or None
    profile_home = _profile_home(profile)
    auto_title = params.get("auto_title", True) is not False
''',
    "Termes resumed session auto-title option",
)
replace_once(
    gateway,
    '''    def _reuse_live_payload(sid: str, session: dict) -> dict:
        payload = _live_session_payload(
''',
    '''    def _reuse_live_payload(sid: str, session: dict) -> dict:
        session["auto_title"] = auto_title
        payload = _live_session_payload(
''',
    "Termes live resumed session auto-title state",
)
replace_once(
    gateway,
    '''            profile_home=profile_home,
            lazy=True,
        )
        if (live := _claim_or_reuse_live(sid, target, record, lease)) is not None:
''',
    '''            profile_home=profile_home,
            lazy=True,
        )
        record["auto_title"] = auto_title
        if (live := _claim_or_reuse_live(sid, target, record, lease)) is not None:
''',
    "Termes lazy resumed session auto-title state",
)
replace_once(
    gateway,
    '''            model_override=overrides.get("model_override"),
            resume_runtime_overrides=overrides or None,
        )
        if (live := _claim_or_reuse_live(sid, target, record, lease)) is not None:
''',
    '''            model_override=overrides.get("model_override"),
            resume_runtime_overrides=overrides or None,
        )
        record["auto_title"] = auto_title
        if (live := _claim_or_reuse_live(sid, target, record, lease)) is not None:
''',
    "Termes cold resumed session auto-title state",
)
replace_once(
    gateway,
    '''            if sid in _sessions:
                if stored_runtime_overrides.get("model_override") is not None:
''',
    '''            if sid in _sessions:
                _sessions[sid]["auto_title"] = auto_title
                if stored_runtime_overrides.get("model_override") is not None:
''',
    "Termes eager resumed session auto-title state",
)
replace_once(
    gateway,
    '''            if (
                status == "complete"
                and isinstance(raw, str)
                and raw.strip()
                and isinstance(text, str)
                and text.strip()
''',
    '''            if (
                session.get("auto_title", True)
                and status == "complete"
                and isinstance(raw, str)
                and raw.strip()
                and isinstance(text, str)
                and text.strip()
''',
    "Termes session auto-title guard",
)

for patched_path in (transport, runtime, session, auth, runtime_provider, gateway):
    compile(patched_path.read_text(), str(patched_path), "exec")

if "Fall back to default runtime" in runtime.read_text() or "Fall back to default runtime" in session.read_text():
    raise SystemExit("Codex runtime fallback instruction remains after patch")

web_server = Path("/opt/hermes/hermes_cli/web_server.py")
replace_once(
    web_server,
    """    return host not in _LOOPBACK_HOST_VALUES
""",
    """    if os.environ.get("TERMES_INTERNAL_DASHBOARD_TOKEN_AUTH") == "true":
        token = os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN", "")
        if len(token) < 32:
            raise RuntimeError(
                "TERMES_INTERNAL_DASHBOARD_TOKEN_AUTH requires a dashboard session token of at least 32 characters"
            )
        return False
    return host not in _LOOPBACK_HOST_VALUES
""",
    "Termes internal dashboard token auth",
)
compile(web_server.read_text(), str(web_server), "exec")
