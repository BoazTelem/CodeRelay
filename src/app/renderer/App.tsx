import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import type { PreflightSummary, ProviderStatusEntry, WorkItemDetail, WorkItemRow } from "./global.js";

type ProviderPair = { codex: ProviderStatusEntry; claude: ProviderStatusEntry };

const TERMINAL_STATUSES = new Set(["COMPLETED", "BLOCKED", "FAILED", "ABORTED"]);

function statusBadge(status: string): string {
  if (status === "COMPLETED") return "good";
  if (status === "ACTIVE") return "accent";
  if (status === "PAUSED") return "warn";
  if (status === "BLOCKED" || status === "FAILED" || status === "ABORTED") return "bad";
  return "dim";
}

function authBadge(entry: ProviderStatusEntry | undefined): { label: string; kind: string } {
  if (!entry || !entry.available) return { label: "not found", kind: "bad" };
  if (entry.authState === "SUBSCRIPTION_VERIFIED") return { label: "subscription", kind: "good" };
  if (entry.authState === "NOT_AUTHENTICATED") return { label: "not logged in", kind: "bad" };
  return { label: entry.authState.toLowerCase().replaceAll("_", " "), kind: "warn" };
}

function timeOf(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

function describeEvent(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["reason", "status", "decision", "provider", "state", "iteration", "contractRevision", "branch", "finalCommit", "message"]) {
    const value = record[key];
    if (value !== undefined && value !== null && typeof value !== "object") parts.push(`${key}=${String(value)}`);
  }
  return parts.join("  ");
}

interface Finding {
  id: string;
  priority: string;
  title: string;
  evidence: string;
  blocking: boolean;
  status: string;
}

function latestFindings(detail: WorkItemDetail | undefined): Finding[] {
  if (!detail) return [];
  for (let index = detail.events.length - 1; index >= 0; index -= 1) {
    const event = detail.events[index];
    if (!event) continue;
    const payload = event.payload as Record<string, unknown> | null;
    if (payload && Array.isArray(payload.findings) && (event.eventType === "audit.completed" || event.eventType === "work_item.run_finished")) {
      return payload.findings as Finding[];
    }
  }
  return [];
}

export function App(): JSX.Element {
  const [providers, setProviders] = useState<ProviderPair>();
  const [providersBusy, setProvidersBusy] = useState(false);
  const [repository, setRepository] = useState("");
  const [preflight, setPreflight] = useState<PreflightSummary>();
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [preflightError, setPreflightError] = useState("");
  const [instruction, setInstruction] = useState("");
  const [allowedPaths, setAllowedPaths] = useState(".");
  const [validationCommand, setValidationCommand] = useState("");
  const [worker, setWorker] = useState<"codex" | "claude">("codex");
  const [confirmedUnpushed, setConfirmedUnpushed] = useState(false);
  const [startBusy, setStartBusy] = useState(false);
  const [startError, setStartError] = useState("");
  const [workItems, setWorkItems] = useState<WorkItemRow[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<WorkItemDetail>();
  const [actionError, setActionError] = useState("");
  const [intervention, setIntervention] = useState("");
  const eventsEnd = useRef<HTMLDivElement>(null);

  const refreshProviders = useCallback(() => {
    setProvidersBusy(true);
    window.coderelay.providerStatus()
      .then(setProviders)
      .catch(() => setProviders(undefined))
      .finally(() => setProvidersBusy(false));
  }, []);

  const refreshWorkItems = useCallback(() => {
    window.coderelay.listWorkItems()
      .then((result) => setWorkItems(result.workItems))
      .catch(() => undefined);
  }, []);

  useEffect(() => { refreshProviders(); refreshWorkItems(); }, [refreshProviders, refreshWorkItems]);

  useEffect(() => {
    if (!selectedId) { setDetail(undefined); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const next = await window.coderelay.getWorkItem(selectedId);
        if (cancelled) return;
        setDetail(next);
        const status = next.workItem ? String(next.workItem.status) : "";
        if (!next.startError && (!next.workItem || !TERMINAL_STATUSES.has(status))) {
          timer = setTimeout(() => { void poll(); }, 1_500);
        } else {
          refreshWorkItems();
        }
      } catch {
        if (!cancelled) timer = setTimeout(() => { void poll(); }, 3_000);
      }
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [selectedId, refreshWorkItems]);

  useEffect(() => {
    eventsEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail?.events.length]);

  const chooseRepository = async (): Promise<void> => {
    const picked = await window.coderelay.pickRepository();
    if (!picked) return;
    setRepository(picked);
    setPreflight(undefined);
    setPreflightError("");
    setConfirmedUnpushed(false);
    setPreflightBusy(true);
    try {
      setPreflight(await window.coderelay.preflight(picked));
    } catch (error) {
      setPreflightError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreflightBusy(false);
    }
  };

  const canStart = useMemo(() => {
    return Boolean(
      repository && preflight && preflight.clean && instruction.trim().length > 0 && !startBusy
      && (!preflight.requiresUnpushedConfirmation || confirmedUnpushed)
      && providers && providers.codex.authState === "SUBSCRIPTION_VERIFIED" && providers.claude.authState === "SUBSCRIPTION_VERIFIED"
    );
  }, [repository, preflight, instruction, startBusy, confirmedUnpushed, providers]);

  const start = async (): Promise<void> => {
    setStartError("");
    setStartBusy(true);
    try {
      const paths = allowedPaths.split(",").map((entry) => entry.trim()).filter(Boolean);
      const validationTokens = validationCommand.trim().split(/\s+/).filter(Boolean);
      const result = await window.coderelay.startWorkItem({
        repository,
        instruction: instruction.trim(),
        allowedPaths: paths.length > 0 ? paths : ["."],
        worker,
        confirmedUnpushed,
        ...(validationTokens.length > 0
          ? { validationCommand: { executable: validationTokens[0]!, args: validationTokens.slice(1) } }
          : {})
      });
      setSelectedId(result.workItemId);
      refreshWorkItems();
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    } finally {
      setStartBusy(false);
    }
  };

  const act = async (action: "pause" | "resume"): Promise<void> => {
    if (!selectedId) return;
    setActionError("");
    try { await window.coderelay[action](selectedId); }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
  };

  const sendIntervention = async (): Promise<void> => {
    if (!selectedId || !intervention.trim()) return;
    setActionError("");
    try {
      await window.coderelay.intervene(selectedId, intervention.trim());
      setIntervention("");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const findings = latestFindings(detail);
  const bothVerified = providers && providers.codex.authState === "SUBSCRIPTION_VERIFIED" && providers.claude.authState === "SUBSCRIPTION_VERIFIED";

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <h1>Code<span>Relay</span></h1>
          <p>Codex ⇄ Claude orchestrated handoffs</p>
        </div>
        <div className="sidebar-section">
          <h2>
            Providers
            <button className="secondary" style={{ padding: "2px 10px", fontSize: 11 }} onClick={refreshProviders} disabled={providersBusy}>
              {providersBusy ? <span className="spinner" /> : "Refresh"}
            </button>
          </h2>
          {(["codex", "claude"] as const).map((name) => {
            const entry = providers?.[name];
            const badge = providersBusy && !providers ? { label: "checking…", kind: "dim" } : authBadge(entry);
            return (
              <div className="provider-row" key={name}>
                <span className="name">{name === "codex" ? "Codex" : "Claude"}</span>
                <span className="version">{entry?.version ?? ""}</span>
                <span className={`badge ${badge.kind}`}>{badge.label}</span>
              </div>
            );
          })}
        </div>
        <div className="sidebar-section" style={{ borderBottom: "none", paddingBottom: 6 }}>
          <h2>
            Work items
            <button className="secondary" style={{ padding: "2px 10px", fontSize: 11 }} onClick={() => setSelectedId(undefined)}>
              + New task
            </button>
          </h2>
        </div>
        <div className="history">
          {workItems.length === 0 && <div className="empty-note">No Work Items yet. Start your first task.</div>}
          {workItems.map((item) => (
            <button
              key={item.id}
              className={`history-item ${item.id === selectedId ? "selected" : ""}`}
              onClick={() => setSelectedId(item.id)}
            >
              <div className="title">{item.title}</div>
              <div className="meta">
                <span className={`badge ${statusBadge(String(item.status))}`}>{item.status}</span>
                <span>{item.stage}</span>
                <span>{timeOf(item.created_at)}</span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className="main">
        {!selectedId && (
          <>
            <h2>New task</h2>
            <p className="subtitle">One provider implements in an isolated worktree; the other independently reviews. Your primary checkout is never touched.</p>

            {!bothVerified && providers && (
              <div className="alert warn">
                Both CLIs must be installed and logged in with a subscription before starting.
                Codex: {authBadge(providers.codex).label} · Claude: {authBadge(providers.claude).label}
              </div>
            )}

            <div className="card">
              <h3>Repository</h3>
              <div className="repo-line">
                <button className="secondary" onClick={() => { void chooseRepository(); }}>Choose repository…</button>
                <span className="repo-path">{repository || "No repository selected"}</span>
                {preflightBusy && <span className="spinner" />}
              </div>
              {preflightError && <div className="alert bad">{preflightError}</div>}
              {preflight && (
                <div style={{ marginTop: 14 }}>
                  <dl className="kv">
                    <dt>Branch</dt><dd>{preflight.currentBranch || "(detached)"}</dd>
                    <dt>HEAD</dt><dd>{preflight.head.slice(0, 12)}</dd>
                    <dt>State</dt>
                    <dd>
                      {preflight.clean
                        ? <span className="badge good">clean</span>
                        : <span className="badge bad">dirty — {preflight.dirtyTracked.length + preflight.staged.length + preflight.untracked.length} changed file(s)</span>}
                    </dd>
                    {preflight.codeRelayBranches.length > 0 && (<><dt>CodeRelay branches</dt><dd>{preflight.codeRelayBranches.length} existing</dd></>)}
                  </dl>
                  {!preflight.clean && (
                    <div className="alert bad">The primary checkout must be clean. Commit, stash, or discard local changes first.</div>
                  )}
                  {preflight.requiresUnpushedConfirmation && (
                    <div className="alert warn">
                      The base commit has {preflight.unpushedCommits ?? "unpushed"} unpushed commit(s). CodeRelay will branch from the local commit and never push.
                      <label className="checkbox-line">
                        <input type="checkbox" checked={confirmedUnpushed} onChange={(event) => setConfirmedUnpushed(event.target.checked)} />
                        I understand — proceed from the local commit
                      </label>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="card">
              <h3>Task</h3>
              <div className="field">
                <label>Instruction <span className="hint">— what should be implemented?</span></label>
                <textarea
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  placeholder="Example: Add input validation to the login form and show inline error messages."
                />
              </div>
              <div className="row">
                <div className="field">
                  <label>Allowed paths <span className="hint">— comma-separated, relative ("." = whole repository)</span></label>
                  <input type="text" value={allowedPaths} onChange={(event) => setAllowedPaths(event.target.value)} />
                </div>
                <div className="field">
                  <label>Validation command <span className="hint">— optional, runs after each iteration (e.g. "npm test")</span></label>
                  <input type="text" value={validationCommand} onChange={(event) => setValidationCommand(event.target.value)} placeholder="none" />
                </div>
              </div>
              <div className="field">
                <label>Roles</label>
                <div className="choice-row">
                  <button className={`choice ${worker === "codex" ? "selected" : ""}`} onClick={() => setWorker("codex")}>
                    <div className="choice-title">Codex implements</div>
                    <div className="choice-sub">Claude reviews independently</div>
                  </button>
                  <button className={`choice ${worker === "claude" ? "selected" : ""}`} onClick={() => setWorker("claude")}>
                    <div className="choice-title">Claude implements</div>
                    <div className="choice-sub">Codex reviews independently</div>
                  </button>
                </div>
              </div>
              {startError && <div className="alert bad">{startError}</div>}
              <button className="primary" disabled={!canStart} onClick={() => { void start(); }}>
                {startBusy ? <><span className="spinner" /> Starting…</> : "Start Work Item"}
              </button>
              <p className="footer-note">
                Your prompt and relevant repository content are sent to the authenticated Codex and Claude services. The result is a local branch only — CodeRelay never pushes, merges, or deploys.
              </p>
            </div>
          </>
        )}

        {selectedId && (
          <>
            <h2>{detail?.workItem?.title ?? selectedId}</h2>
            <p className="subtitle" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{selectedId}</p>

            {detail?.startError && <div className="alert bad">Start failed: {detail.startError}</div>}

            {detail?.workItem && (
              <>
                <div className="status-line">
                  <span className={`badge ${statusBadge(String(detail.workItem.status))}`}>{String(detail.workItem.status)}</span>
                  <span className="badge dim">{String(detail.workItem.stage)}</span>
                  <span className="badge dim">iteration {String(detail.workItem.iteration)}</span>
                  {!TERMINAL_STATUSES.has(String(detail.workItem.status)) && <span className="spinner" />}
                  <span className="spacer" />
                  {String(detail.workItem.status) === "ACTIVE" && <button className="secondary" onClick={() => { void act("pause"); }}>Pause</button>}
                  {["PAUSED", "BLOCKED"].includes(String(detail.workItem.status)) && <button className="secondary" onClick={() => { void act("resume"); }}>Resume</button>}
                </div>

                {String(detail.workItem.status) === "COMPLETED" && (
                  <div className="alert good">
                    Completed. The result is on local branch <strong>{String(detail.workItem.branch)}</strong> — review it with
                    {" "}<code style={{ fontFamily: "var(--mono)" }}>git log {String(detail.workItem.branch)}</code> and merge when satisfied.
                  </div>
                )}

                <div className="card">
                  <h3>Details</h3>
                  <dl className="kv">
                    <dt>Repository</dt><dd>{String(detail.workItem.primary_root)}</dd>
                    <dt>Branch</dt><dd>{String(detail.workItem.branch)}</dd>
                    <dt>Started</dt><dd>{timeOf(String(detail.workItem.created_at))}</dd>
                    <dt>Updated</dt><dd>{timeOf(String(detail.workItem.updated_at))}</dd>
                  </dl>
                </div>

                {findings.length > 0 && (
                  <div className="card">
                    <h3>Auditor findings</h3>
                    {findings.map((finding) => (
                      <div className="finding" key={finding.id}>
                        <div className="finding-head">
                          <span className={`badge ${finding.blocking ? "bad" : "warn"}`}>{finding.priority}</span>
                          <span className="finding-title">{finding.title}</span>
                          <span className="badge dim">{finding.status}</span>
                        </div>
                        <div className="finding-evidence">{finding.evidence}</div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="card">
                  <h3>Timeline</h3>
                  <div className="event-feed">
                    {detail.events.map((event) => (
                      <div className="event-row" key={event.sequence}>
                        <span className="event-time">{timeOf(event.createdAt)}</span>
                        <span className="event-type">{event.eventType}</span>
                        <span className="event-detail">{describeEvent(event.payload)}</span>
                      </div>
                    ))}
                    <div ref={eventsEnd} />
                  </div>
                  {!TERMINAL_STATUSES.has(String(detail.workItem.status)) && (
                    <div className="intervene-row">
                      <input
                        type="text"
                        value={intervention}
                        onChange={(event) => setIntervention(event.target.value)}
                        placeholder="Intervene: revise the instruction (pauses, checkpoints, and replans)"
                        onKeyDown={(event) => { if (event.key === "Enter") void sendIntervention(); }}
                      />
                      <button className="secondary" onClick={() => { void sendIntervention(); }} disabled={!intervention.trim()}>Send</button>
                    </div>
                  )}
                </div>

                {actionError && <div className="alert bad">{actionError}</div>}
              </>
            )}

            {!detail && <p className="subtitle"><span className="spinner" /> Loading…</p>}
          </>
        )}
      </main>
    </div>
  );
}
