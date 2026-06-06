#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_KEY = process.env.FIRESTARTER_API_KEY;
const API_BASE = process.env.FIRESTARTER_API_URL || "https://api.firestarter.network";

if (!API_KEY) {
  console.error("FIRESTARTER_API_KEY environment variable is required");
  process.exit(1);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function apiRequest(method: string, path: string, body?: unknown) {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `API request failed: ${res.status}`);
  }
  return data;
}

async function pollExecution(executionId: string, timeoutMs: number = 60_000): Promise<any> {
  const start = Date.now();
  const pollInterval = 2_000;

  while (Date.now() - start < timeoutMs) {
    const exec = await apiRequest("GET", `/v1/executions/${executionId}`);

    // Terminal or actionable states
    if (["awaiting_approval", "completed", "failed", "cancelled", "paid", "shipping", "delivered"].includes(exec.status)) {
      return exec;
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  // Final fetch after timeout
  return apiRequest("GET", `/v1/executions/${executionId}`);
}

function formatExecution(exec: any): string {
  const lines: string[] = [];

  lines.push(`**Execution ${exec.id}** — Status: ${exec.status}`);
  lines.push(`Request: ${exec.request_text}`);

  if (exec.current_step) {
    lines.push(`Current step: ${exec.current_step}`);
  }

  // Show options if awaiting approval
  if (exec.options && exec.options.length > 0) {
    lines.push("");
    lines.push("**Options found:**");
    for (const opt of exec.options) {
      lines.push(`- **${opt.product_title}** — $${opt.total} from ${opt.store}`);
      if (opt.product_url) lines.push(`  URL: ${opt.product_url}`);
      if (opt.agent_reasoning) lines.push(`  ${opt.agent_reasoning}`);
    }
  }

  // Show steps
  if (exec.steps && exec.steps.length > 0) {
    lines.push("");
    lines.push("**Steps:**");
    for (const step of exec.steps) {
      const icon = step.status === "completed" ? "✓" : step.status === "failed" ? "✗" : "⧖";
      lines.push(`${icon} ${step.step}: ${step.agent_reasoning || step.status}`);
      if (step.error?.message) {
        lines.push(`  Error: ${step.error.message}`);
      }
    }
  }

  return lines.join("\n");
}

// ─── MCP Server ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "firestarter",
  version: "1.0.0",
});

// Tool: firestarter_execute
server.tool(
  "firestarter_execute",
  "Execute a commerce transaction. Find products matching a natural language request, verify suppliers, get pricing, and optionally handle payment and delivery. Returns product options for approval.",
  {
    request: z.string().describe("Natural language description of what to buy (e.g. 'specialty coffee beans under $30')"),
    budget_max: z.number().optional().describe("Maximum budget in USD"),
    delivery_address: z.string().optional().describe("Delivery address as a string"),
    priority: z.enum(["cost", "speed", "quality"]).optional().describe("Optimization priority: cost (cheapest), speed (fastest delivery), quality (best rated)"),
    auto_pay: z.boolean().optional().describe("If true, automatically pay for the best option within budget. If false (default), present options for approval."),
  },
  async ({ request, budget_max, delivery_address, priority, auto_pay }) => {
    try {
      // Build execution request
      const body: any = {
        request,
        preferences: {
          priority: priority || "quality",
          require_approval: !auto_pay,
        },
      };

      if (budget_max) {
        body.budget = { max_total: budget_max, currency: "USD" };
      }

      if (delivery_address) {
        body.delivery_address = { address: delivery_address };
      }

      // Submit execution
      const created = await apiRequest("POST", "/v1/executions", body);

      // Poll until we have results or need user action
      const exec = await pollExecution(created.id);

      const output = formatExecution(exec);

      // If awaiting approval, include action hint
      if (exec.status === "awaiting_approval") {
        return {
          content: [{
            type: "text" as const,
            text: output + "\n\n**Action needed:** Use `firestarter_approve` to approve an option, or `firestarter_cancel` to cancel.",
          }],
        };
      }

      return {
        content: [{ type: "text" as const, text: output }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: firestarter_status
server.tool(
  "firestarter_status",
  "Check the status of a Firestarter execution or list recent executions. Use this to check on orders, see what options were found, or get tracking updates.",
  {
    execution_id: z.string().optional().describe("Specific execution ID to check (e.g. 'exec_abc123'). Omit to list recent executions."),
    status_filter: z.string().optional().describe("Filter executions by status: finding, awaiting_approval, approved, paid, shipping, completed, failed, cancelled"),
  },
  async ({ execution_id, status_filter }) => {
    try {
      if (execution_id) {
        const exec = await apiRequest("GET", `/v1/executions/${execution_id}`);
        return {
          content: [{ type: "text" as const, text: formatExecution(exec) }],
        };
      }

      // List recent executions
      let path = "/v1/executions";
      if (status_filter) {
        path += `?status=${encodeURIComponent(status_filter)}`;
      }
      const data = await apiRequest("GET", path);
      const executions = data.executions || data;

      if (!Array.isArray(executions) || executions.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No executions found." }],
        };
      }

      const lines = [`**Recent Executions** (${data.total || executions.length} total)\n`];
      for (const e of executions.slice(0, 10)) {
        lines.push(`- **${e.id}** [${e.status}] ${e.request_text?.slice(0, 60) || ""}${e.request_text?.length > 60 ? "..." : ""}`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: firestarter_approve
server.tool(
  "firestarter_approve",
  "Approve an execution that is awaiting approval. This selects the best option and proceeds with payment.",
  {
    execution_id: z.string().describe("The execution ID to approve (e.g. 'exec_abc123')"),
    selected_option: z.number().optional().describe("Index of the option to select (0-based). Defaults to 0 (best option)."),
  },
  async ({ execution_id, selected_option }) => {
    try {
      const body: any = {};
      if (selected_option !== undefined) {
        body.selected_option = selected_option;
      }

      await apiRequest("POST", `/v1/executions/${execution_id}/approve`, body);

      // Poll for result
      const exec = await pollExecution(execution_id, 30_000);

      return {
        content: [{ type: "text" as const, text: `Execution approved.\n\n${formatExecution(exec)}` }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error approving: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: firestarter_cancel
server.tool(
  "firestarter_cancel",
  "Cancel an active execution. If payment was authorized, the hold will be released.",
  {
    execution_id: z.string().describe("The execution ID to cancel"),
    reason: z.string().optional().describe("Reason for cancellation"),
  },
  async ({ execution_id, reason }) => {
    try {
      await apiRequest("POST", `/v1/executions/${execution_id}/cancel`, { reason });
      return {
        content: [{ type: "text" as const, text: `Execution ${execution_id} cancelled.${reason ? ` Reason: ${reason}` : ""}` }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error cancelling: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: firestarter_message
server.tool(
  "firestarter_message",
  "Send a follow-up message to an active execution. Use this to refine the search, change requirements, or ask questions about the options.",
  {
    execution_id: z.string().describe("The execution ID to message"),
    message: z.string().describe("Follow-up message (e.g. 'I prefer organic options' or 'Can you find something cheaper?')"),
  },
  async ({ execution_id, message }) => {
    try {
      await apiRequest("POST", `/v1/executions/${execution_id}/message`, { message });

      // Poll for updated results
      const exec = await pollExecution(execution_id, 30_000);

      return {
        content: [{ type: "text" as const, text: formatExecution(exec) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ─── Monitor Tools ─────────────────────────────────────────────────────────

// Tool: firestarter_watch
server.tool(
  "firestarter_watch",
  "Create a price/stock monitor that watches products on a schedule. Get notified via webhook when prices drop, items restock, or new listings appear.",
  {
    name: z.string().describe("Name for this monitor (e.g. 'AirPods price watch')"),
    query: z.string().describe("What to watch — natural language (e.g. 'AirPods Pro 2 under $200')"),
    schedule: z.string().optional().describe("How often to check: 'hourly', 'daily', 'daily at 9am', 'every 6 hours', or a cron expression. Default: 'daily'"),
    price_drop_pct: z.number().optional().describe("Minimum price drop percentage to notify (e.g. 10 = notify on 10%+ drops)"),
    goal: z.string().optional().describe("Natural language goal for AI-powered meaningful change detection (e.g. 'price drops below $180')"),
    webhook_url: z.string().optional().describe("Webhook URL to receive change notifications"),
  },
  async ({ name, query, schedule, price_drop_pct, goal, webhook_url }) => {
    try {
      const body: any = {
        name,
        type: "product",
        targets: [{ query }],
        schedule: schedule || "daily",
        conditions: {},
      };

      if (price_drop_pct) body.conditions.price_drop_pct = price_drop_pct;
      if (goal) body.goal = goal;
      if (webhook_url) body.notifications = { webhook: { url: webhook_url } };

      const monitor = await apiRequest("POST", "/v1/monitors", body);

      return {
        content: [{
          type: "text" as const,
          text: `**Monitor created: ${monitor.name}**\n` +
            `ID: ${monitor.id}\n` +
            `Schedule: ${monitor.schedule} (${monitor.schedule_cron})\n` +
            `Next check: ${monitor.next_check_at}\n` +
            (goal ? `Goal: ${goal}\n` : "") +
            `\nUse \`firestarter_watches\` to see all active monitors.`,
        }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error creating monitor: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: firestarter_watches
server.tool(
  "firestarter_watches",
  "List active monitors and their recent check results. Shows what you're watching, last check status, and any recent price changes or alerts.",
  {
    monitor_id: z.string().optional().describe("Get details for a specific monitor ID. Omit to list all monitors."),
    include_checks: z.boolean().optional().describe("Include recent check history (default: true for single monitor, false for list)"),
  },
  async ({ monitor_id, include_checks }) => {
    try {
      if (monitor_id) {
        const monitor = await apiRequest("GET", `/v1/monitors/${monitor_id}`);
        const checks = include_checks !== false
          ? await apiRequest("GET", `/v1/monitors/${monitor_id}/checks?limit=5`)
          : null;

        let text = `**${monitor.name}** [${monitor.status}]\n` +
          `Type: ${monitor.type} | Schedule: ${monitor.schedule}\n` +
          `Targets: ${monitor.targets.map((t: any) => t.query).join(", ")}\n`;

        if (monitor.goal) text += `Goal: ${monitor.goal}\n`;
        if (monitor.last_check_at) text += `Last check: ${monitor.last_check_at}\n`;
        if (monitor.next_check_at) text += `Next check: ${monitor.next_check_at}\n`;

        if (checks?.checks?.length > 0) {
          text += "\n**Recent checks:**\n";
          for (const chk of checks.checks) {
            const s = chk.summary || {};
            text += `- ${chk.completed_at || chk.created_at}: ${chk.status}`;
            if (s.price_drops) text += ` | ${s.price_drops} price drop(s)`;
            if (s.new_listings) text += ` | ${s.new_listings} new listing(s)`;
            text += ` | ${s.products_checked || 0} products checked\n`;

            if (chk.changes?.length > 0) {
              for (const c of chk.changes.slice(0, 3)) {
                text += `  ${c.status}: ${c.product}`;
                if (c.previous_price && c.current_price) text += ` $${c.previous_price} → $${c.current_price}`;
                if (c.drop_pct) text += ` (-${c.drop_pct}%)`;
                if (c.judgment?.meaningful) text += ` ✓ ${c.judgment.reason}`;
                text += "\n";
              }
            }
          }
        }

        return { content: [{ type: "text" as const, text }] };
      }

      // List all monitors
      const data = await apiRequest("GET", "/v1/monitors");
      const monitors = data.monitors || [];

      if (monitors.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "No monitors set up yet. Use `firestarter_watch` to create one.",
          }],
        };
      }

      const lines = [`**Active Monitors** (${monitors.length})\n`];
      for (const m of monitors) {
        lines.push(`- **${m.name}** [${m.status}] — ${m.schedule}`);
        lines.push(`  ID: ${m.id} | Targets: ${m.targets.map((t: any) => t.query).join(", ")}`);
        if (m.last_check_at) lines.push(`  Last check: ${m.last_check_at}`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: firestarter_unwatch
server.tool(
  "firestarter_unwatch",
  "Pause or delete a monitor. Paused monitors can be resumed later; deleted monitors are permanent.",
  {
    monitor_id: z.string().describe("The monitor ID to pause or delete"),
    action: z.enum(["pause", "resume", "delete"]).describe("Action to take: pause (stop checks, keep history), resume (restart checks), delete (permanent)"),
  },
  async ({ monitor_id, action }) => {
    try {
      if (action === "delete") {
        await apiRequest("DELETE", `/v1/monitors/${monitor_id}`);
        return {
          content: [{ type: "text" as const, text: `Monitor ${monitor_id} deleted.` }],
        };
      }

      const result = await apiRequest("POST", `/v1/monitors/${monitor_id}/${action}`);
      return {
        content: [{
          type: "text" as const,
          text: `Monitor ${monitor_id} ${action}d. Status: ${result.status}`,
        }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: firestarter_check
server.tool(
  "firestarter_check",
  "Trigger an immediate check on a monitor. Runs the product search and diff right now instead of waiting for the next scheduled check.",
  {
    monitor_id: z.string().describe("The monitor ID to check now"),
  },
  async ({ monitor_id }) => {
    try {
      await apiRequest("POST", `/v1/monitors/${monitor_id}/run`);

      // Wait a bit for the check to complete
      await new Promise(r => setTimeout(r, 5000));

      const checks = await apiRequest("GET", `/v1/monitors/${monitor_id}/checks?limit=1`);
      const latest = checks.checks?.[0];

      if (!latest || latest.status === "queued" || latest.status === "running") {
        return {
          content: [{
            type: "text" as const,
            text: `Check queued for monitor ${monitor_id}. It may take a minute to complete. Use \`firestarter_watches\` to see results.`,
          }],
        };
      }

      const s = latest.summary || {};
      let text = `**Check completed** for monitor ${monitor_id}\n`;
      text += `Products checked: ${s.products_checked || 0}\n`;
      text += `Price drops: ${s.price_drops || 0} | New listings: ${s.new_listings || 0}\n`;

      if (latest.changes?.length > 0) {
        text += "\n**Changes detected:**\n";
        for (const c of latest.changes) {
          text += `- ${c.status}: ${c.product}`;
          if (c.previous_price && c.current_price) text += ` $${c.previous_price} → $${c.current_price}`;
          if (c.drop_pct) text += ` (-${c.drop_pct}%)`;
          if (c.judgment) text += c.judgment.meaningful ? ` ✓ ${c.judgment.reason}` : ` ○ ${c.judgment.reason}`;
          text += "\n";
        }
      } else {
        text += "\nNo changes detected since last check.";
      }

      return { content: [{ type: "text" as const, text }] };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ─── Start ──────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
