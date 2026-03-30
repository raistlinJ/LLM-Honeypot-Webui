# ABOUTME: LLM client for communicating with OpenAI-compatible APIs.
# ABOUTME: Sends shell commands to an LLM and returns simulated responses.

from __future__ import annotations

import json
import os
import urllib.parse
from typing import TYPE_CHECKING, Any

from twisted.internet import defer, protocol, reactor
from twisted.internet.defer import Deferred, inlineCallbacks
from twisted.internet.endpoints import HostnameEndpoint
from twisted.python import failure as tw_failure
from twisted.python import log
from twisted.web.client import (
    Agent,
    HTTPConnectionPool,
    ProxyAgent,
    _HTTP11ClientFactory,
)
from twisted.web.http_headers import Headers
from twisted.web.iweb import IBodyProducer, IResponse
from zope.interface import implementer

from cowrie.core.config import CowrieConfig

if TYPE_CHECKING:
    from collections.abc import Generator


@implementer(IBodyProducer)
class StringProducer:
    """
    Feeds a request body to the HTTP client.
    """

    def __init__(self, body: str) -> None:
        self.body = body.encode("utf-8")
        self.length = len(self.body)

    def startProducing(self, consumer):
        consumer.write(self.body)
        return defer.succeed(None)

    def pauseProducing(self) -> None:
        pass

    def resumeProducing(self) -> None:
        pass

    def stopProducing(self) -> None:
        pass


class SimpleResponseReceiver(protocol.Protocol):
    """
    Collects the response body from an HTTP response.
    """

    def __init__(self, status_code: int, d: defer.Deferred) -> None:
        self.status_code = status_code
        self.buf = b""
        self.d = d

    def dataReceived(self, data: bytes) -> None:
        self.buf += data

    def connectionLost(self, reason: tw_failure.Failure = protocol.connectionDone) -> None:
        self.d.callback((self.status_code, self.buf))


class QuietHTTP11ClientFactory(_HTTP11ClientFactory):
    """
    Silences factory start/stop log messages.
    """

    noisy = False


class LLMClient:
    """
    Client for communicating with OpenAI-compatible LLM APIs.
    """

    def __init__(self) -> None:
        self._conn_pool = HTTPConnectionPool(reactor)
        self._conn_pool._factory = QuietHTTP11ClientFactory

        self.api_key = CowrieConfig.get("llm", "api_key", fallback="")
        self.model = CowrieConfig.get("llm", "model", fallback="gpt-4o-mini")
        self.host = CowrieConfig.get("llm", "host", fallback="https://api.openai.com")
        self.path = CowrieConfig.get("llm", "path", fallback="/v1/chat/completions")
        self.max_tokens = CowrieConfig.getint("llm", "max_tokens", fallback=500)
        self.temperature = CowrieConfig.getfloat("llm", "temperature", fallback=0.7)
        self.debug = CowrieConfig.getboolean("llm", "debug", fallback=False)

        proxy_url = (
            os.environ.get("https_proxy")
            or os.environ.get("HTTPS_PROXY")
            or os.environ.get("http_proxy")
            or os.environ.get("HTTP_PROXY")
        )
        if proxy_url:
            parsed = urllib.parse.urlparse(proxy_url)
            proxy_endpoint = HostnameEndpoint(
                reactor, parsed.hostname or "localhost", parsed.port or 8080
            )
            self.agent = ProxyAgent(proxy_endpoint, reactor, pool=self._conn_pool)  # type: ignore[assignment]
            log.msg(f"LLM using proxy: {parsed.hostname}:{parsed.port}")
        else:
            self.agent = Agent(reactor, pool=self._conn_pool)

        if not self.api_key:
            log.msg("WARNING: No LLM API key configured in [llm] section")

    def _build_headers(self) -> Headers:
        """Build HTTP headers with authentication."""
        return Headers(
            {
                b"Content-Type": [b"application/json"],
                b"Authorization": [f"Bearer {self.api_key}".encode()],
            }
        )

    def _format_request_body(self, prompt: list[str]) -> dict:
        """Structure the request body for OpenAI chat completions API."""
        messages = []
        for i, message in enumerate(prompt):
            if i == 0:
                # First message is our system prompt
                messages.append({"role": "system", "content": message})
            elif message.startswith("User:"):
                content = message[5:].strip()
                messages.append({"role": "user", "content": content})
            elif message.startswith("System:"):
                content = message[7:].strip()
                messages.append({"role": "assistant", "content": content})
            else:
                messages.append({"role": "user", "content": message})

        return {
            "model": self.model,
            "messages": messages,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
        }

    def _handle_response_body(
        self, response: IResponse, session: str | None = None, sensor: str | None = None
    ) -> Deferred[tuple[int, bytes]]:
        """Extract the response body from the HTTP response."""
        d: Deferred[tuple[int, bytes]] = defer.Deferred()
        response.deliverBody(SimpleResponseReceiver(response.code, d))
        return d

    def _handle_connection_error(
        self, err: tw_failure.Failure, session: str | None = None, sensor: str | None = None
    ) -> tuple[int, bytes]:
        """Handle connection errors."""
        error_msg = err.getErrorMessage()
        log.msg(
            eventid="cowrie.llm.error",
            status=0,
            error=error_msg,
            format="LLM connection error: %(error)s",
            message=f"LLM connection error: {error_msg}",
            comp="cowrie",
            session=session,
            sensor=sensor
        )
        log.err(f"LLM connection error: {error_msg}")
        return (0, error_msg.encode("utf-8"))

    def _send_request(self, prompt: list[str]) -> Deferred[tuple[int, bytes]]:
        """Send request to the LLM API."""
        request_body = self._format_request_body(prompt)

        log.msg(
            eventid="cowrie.llm.request",
            request=request_body,
            prompt="\n\n".join([f"[{m['role'].upper()}]\n{m['content']}" for m in request_body.get("messages", [])]),
            format="LLM request: %(request)s",
            comp="cowrie",
            message=f"LLM request: {request_body.get('model')}"
        )

        url = f"{self.host}{self.path}"
        d: Deferred[Any] = self.agent.request(
            b"POST",
            url.encode("utf-8"),
            headers=self._build_headers(),
            bodyProducer=StringProducer(json.dumps(request_body)),
        )

        # Capture logging context to preserve it across asynchronous callbacks
        session = log.context.get("session")
        sensor = log.context.get("sensor")

        d.addCallbacks(
            self._handle_response_body, 
            self._handle_connection_error,
            callbackArgs=(session, sensor),
            errbackArgs=(session, sensor)
        )
        return d

    @inlineCallbacks
    def get_response(
        self, prompt: list[str]
    ) -> Generator[Deferred[Any], Any, str]:
        """
        Get a response from the LLM for the given prompt.

        Args:
            prompt: List of messages. First is system prompt, rest are
                    conversation history with "User:" and "System:" prefixes.

        Returns:
            The LLM's response text, or empty string on error.
        """
        # Capture session/sensor context BEFORE the yield to ensure it's preserved
        session = log.context.get("session")
        sensor = log.context.get("sensor")

        status_code, response = yield self._send_request(prompt)

        if status_code != 200:
            error_msg = response.decode("utf-8")
            log.msg(
                eventid="cowrie.llm.error",
                status=status_code,
                error=error_msg,
                format="LLM API error (status %(status)s): %(error)s",
                message=f"LLM API error (status {status_code})",
                comp="cowrie",
                session=session,
                sensor=sensor
            )
            log.err(f"LLM API error (status {status_code}): {error_msg}")
            return ""

        try:
            response_json = json.loads(response)
        except json.JSONDecodeError as e:
            log.err(f"Failed to parse LLM response: {e}")
            return ""

        # Explicitly log the response with session context to ensure it reaches the audit log
        log.msg(
            eventid="cowrie.llm.response",
            response=json.loads(json.dumps(response_json)),
            format="LLM response: %(response)s",
            message=f"LLM response: {response_json.get('model', 'unknown')}",
            comp="cowrie",
            session=session,
            sensor=sensor,
            system=f"cowrie,session,{session}" if session else "cowrie"
        )

        if "choices" in response_json and len(response_json["choices"]) > 0:
            msg = response_json["choices"][0]["message"]
            content = msg.get("content") or msg.get("reasoning_content") or msg.get("reasoning") or msg.get("thought") or ""
            return content

        log.err(f"Unexpected LLM response format: {response}")
        return ""

