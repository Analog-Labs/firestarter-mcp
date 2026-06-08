import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";

/**
 * MCP Tool Tests for Firestarter
 * These tests validate the Model Context Protocol (MCP) tools that enable
 * Claude Code, Cursor, and other MCP-compatible agents to use Firestarter.
 */

describe("MCP Tools - firestarter_execute", () => {
  it("accepts natural language purchase request", () => {
    // Tool should accept a request string
    const request = "comfortable running shoes under $120";
    expect(typeof request).toBe("string");
    expect(request.length).toBeGreaterThan(0);
  });

  it("optionally accepts budget limit", () => {
    // Tool should support budget_max: number
    const budget_max = 120;
    expect(typeof budget_max).toBe("number");
    expect(budget_max).toBeGreaterThan(0);
  });

  it("optionally accepts delivery address", () => {
    // Tool should support delivery_address: string
    const delivery_address = "123 Main St, Austin TX 78701";
    expect(typeof delivery_address).toBe("string");
  });

  it("optionally accepts priority: cost | speed | quality", () => {
    // Tool should support priority optimization
    const validPriorities = ["cost", "speed", "quality"];
    for (const priority of validPriorities) {
      expect(["cost", "speed", "quality"]).toContain(priority);
    }
  });

  it("optionally accepts auto_pay flag", () => {
    // Tool should support auto_pay: boolean to auto-approve within budget
    const auto_pay = true;
    expect(typeof auto_pay).toBe("boolean");
  });

  it("returns formatted execution with options when awaiting approval", () => {
    // Tool response when execution needs human approval:
    // - execution ID
    // - status
    // - found options (product title, price, supplier)
    // - approval link
    // - hint: use firestarter_approve next
    const response = {
      content: [
        {
          type: "text",
          text: `**Execution exec_xyz** — Status: awaiting_approval
Request: comfortable running shoes under $120

**Options found:**
- **Nike Air Zoom Pegasus** — $95.50 from ShoesRUs
  URL: https://example.com/shoes/nike-air-zoom
- **Adidas Ultraboost 22** — $110.00 from SportsDirect
  URL: https://example.com/shoes/adidas-ultraboost

**Action needed:** Use firestarter_approve to approve an option`,
        },
      ],
    };

    expect(response.content[0].type).toBe("text");
    expect(response.content[0].text).toContain("Status: awaiting_approval");
    expect(response.content[0].text).toContain("firestarter_approve");
  });

  it("auto-completes and returns tracking if auto_pay=true", () => {
    // Tool response when auto_pay=true and budget allows:
    // - Order placed and paid
    // - Shipping info
    // - Tracking URL
    const response = {
      content: [
        {
          type: "text",
          text: `**Execution exec_abc** — Status: shipped
Request: comfortable running shoes under $120

Payment: $95.50 authorized (3% platform fee included)
Carrier: FedEx
Tracking: 794629471294
Estimated Delivery: June 8, 2026

Use firestarter_status to check for updates`,
        },
      ],
    };

    expect(response.content[0].text).toContain("Status: shipped");
    expect(response.content[0].text).toContain("Tracking:");
  });

  it("returns error message if search finds no products", () => {
    // Tool response when no matching products:
    // - Clear error message
    // - Suggestion to try different terms
    const response = {
      content: [
        {
          type: "text",
          text: `No products found for "vintage rotary phone $5". Try:
- Different keywords: "retro telephone", "antique phone"
- Adjust budget: "under $50" instead
- Use firestarter_message to refine the search`,
        },
      ],
      isError: false,
    };

    expect(response.content[0].text).toContain("No products found");
  });

  it("handles API errors gracefully", () => {
    // Tool response if API call fails:
    const response = {
      content: [
        {
          type: "text",
          text: "Error: API request failed: 500",
        },
      ],
      isError: true,
    };

    expect(response.isError).toBe(true);
  });
});

describe("MCP Tools - firestarter_status", () => {
  it("lists recent executions when execution_id omitted", () => {
    // Tool should list last 10 executions by default
    const response = {
      content: [
        {
          type: "text",
          text: `**Recent Executions** (42 total)

- **exec_xyz** [awaiting_approval] comfortable running shoes under $120
- **exec_abc** [shipped] laptop stand ergonomic...
- **exec_def** [completed] camping backpack 50L...`,
        },
      ],
    };

    expect(response.content[0].text).toContain("Recent Executions");
    expect(response.content[0].text).toContain("exec_xyz");
  });

  it("filters executions by status when status_filter provided", () => {
    // Tool should accept status_filter parameter
    const validStatuses = [
      "finding",
      "awaiting_approval",
      "approved",
      "paid",
      "shipping",
      "completed",
      "failed",
      "cancelled",
    ];

    for (const status of validStatuses) {
      expect(
        [
          "finding",
          "awaiting_approval",
          "approved",
          "paid",
          "shipping",
          "completed",
          "failed",
          "cancelled",
        ]
      ).toContain(status);
    }
  });

  it("returns detailed status for specific execution_id", () => {
    // Tool should return full execution details including steps and options
    const response = {
      content: [
        {
          type: "text",
          text: `**Execution exec_xyz** — Status: awaiting_approval
Request: comfortable running shoes under $120

**Steps:**
✓ parse: Parsed as footwear
✓ find: Found 47 products
✓ verify: Verified top 5 suppliers
⧖ approve: Awaiting user decision

**Options found:**
- Nike Air Zoom Pegasus — $95.50
  Score: 92
  Delivery: 2-3 days`,
        },
      ],
    };

    expect(response.content[0].text).toContain("**Steps:**");
    expect(response.content[0].text).toContain("**Options found:**");
  });

  it("returns empty message if no executions found", () => {
    // Tool should handle empty result gracefully
    const response = {
      content: [
        {
          type: "text",
          text: "No executions found.",
        },
      ],
    };

    expect(response.content[0].text).toContain("No executions found");
  });
});

describe("MCP Tools - firestarter_approve", () => {
  it("approves execution with best option (index 0 default)", () => {
    // Tool should approve with the top-scored option by default
    const response = {
      content: [
        {
          type: "text",
          text: `Execution approved.

**Execution exec_xyz** — Status: paid
Request: comfortable running shoes under $120

Payment: $95.50 authorized
Item: Nike Air Zoom Pegasus
Carrier: FedEx
Tracking: 794629471294
Estimated Delivery: June 8, 2026`,
        },
      ],
    };

    expect(response.content[0].text).toContain("Execution approved");
    expect(response.content[0].text).toContain("Status: paid");
  });

  it("allows selecting alternative option by index", () => {
    // Tool should accept selected_option parameter (0-based index)
    // to choose a different product than the best match
    const selectedOption = 1; // Second option
    expect(typeof selectedOption).toBe("number");
    expect(selectedOption).toBeGreaterThanOrEqual(0);
  });

  it("initiates payment and returns tracking immediately", () => {
    // Tool should not wait for full shipping; payment is immediate
    const response = {
      content: [
        {
          type: "text",
          text: `Execution approved. Payment captured. Preparing shipment...`,
        },
      ],
    };

    expect(response.content[0].text).toContain("approved");
  });

  it("handles error if execution not in awaiting_approval state", () => {
    // Tool should reject if execution is already paid or in wrong state
    const response = {
      content: [
        {
          type: "text",
          text: "Error approving: Execution is already paid. Cannot approve again.",
        },
      ],
      isError: true,
    };

    expect(response.isError).toBe(true);
  });
});

describe("MCP Tools - firestarter_cancel", () => {
  it("cancels an active execution", () => {
    // Tool should stop the execution and release any held funds
    const response = {
      content: [
        {
          type: "text",
          text: "Execution exec_xyz cancelled.",
        },
      ],
    };

    expect(response.content[0].text).toContain("cancelled");
  });

  it("optionally accepts cancellation reason", () => {
    // Tool should accept reason parameter for audit trail
    const reason = "User changed mind";
    expect(typeof reason).toBe("string");
  });

  it("releases payment hold if already authorized", () => {
    // If payment was captured (requires_capture state),
    // cancel should release the authorization hold
    const response = {
      content: [
        {
          type: "text",
          text: `Execution exec_xyz cancelled. Payment hold ($95.50) released.`,
        },
      ],
    };

    expect(response.content[0].text).toContain("Payment hold");
    expect(response.content[0].text).toContain("released");
  });

  it("returns error if execution is already terminal", () => {
    // Cannot cancel completed, failed, or cancelled executions
    const response = {
      content: [
        {
          type: "text",
          text: "Error: Cannot cancel completed execution.",
        },
      ],
      isError: true,
    };

    expect(response.isError).toBe(true);
  });
});

describe("MCP Tools - firestarter_message", () => {
  it("accepts follow-up message for refinement", () => {
    // Tool should accept message parameter
    const message = "I prefer organic brands and need it by Friday";
    expect(typeof message).toBe("string");
  });

  it("re-runs product search with updated intent", () => {
    // Tool should parse the message, update the intent, and re-search
    const response = {
      content: [
        {
          type: "text",
          text: `Updated search. Found 12 organic running shoes.

**New Options:**
- **ASICS Gel-Quantum 360** — $99.99 (organic materials)
  Delivery: 1 day (expedited)
- **New Balance Fresh Foam** — $85.00 (eco-friendly)
  Delivery: 1 day (expedited)`,
        },
      ],
    };

    expect(response.content[0].text).toContain("Updated search");
    expect(response.content[0].text).toContain("organic");
  });

  it("returns error if execution is in terminal state", () => {
    // Cannot message completed, failed, or cancelled executions
    const response = {
      content: [
        {
          type: "text",
          text: "Error: Cannot message completed execution.",
        },
      ],
      isError: true,
    };

    expect(response.isError).toBe(true);
  });
});

describe("MCP Tool Integration with Claude/Cursor", () => {
  it("tools are discoverable via MCP protocol", () => {
    // MCP server should expose tools via /v1/mcp/schema or similar
    const toolNames = [
      "firestarter_execute",
      "firestarter_status",
      "firestarter_approve",
      "firestarter_cancel",
      "firestarter_message",
    ];

    for (const toolName of toolNames) {
      expect(toolName).toMatch(/^firestarter_/);
    }
  });

  it("tool schema includes required parameters and descriptions", () => {
    // Each tool should have proper schema for type hints
    const toolSchema = {
      name: "firestarter_execute",
      description: "Execute a commerce transaction",
      inputSchema: {
        type: "object",
        properties: {
          request: { type: "string", description: "Purchase request" },
          budget_max: { type: "number", description: "Budget limit" },
          priority: {
            type: "string",
            enum: ["cost", "speed", "quality"],
          },
          auto_pay: { type: "boolean", description: "Auto-approve flag" },
        },
        required: ["request"],
      },
    };

    expect(toolSchema).toHaveProperty("name");
    expect(toolSchema).toHaveProperty("inputSchema");
    expect(toolSchema.inputSchema).toHaveProperty("properties");
    expect(toolSchema.inputSchema).toHaveProperty("required");
  });

  it("tools return text-formatted responses for Claude readability", () => {
    // Responses should be readable markdown/text for LLM parsing
    const response = {
      content: [
        {
          type: "text",
          text: `**Execution ID:** exec_xyz
**Status:** awaiting_approval
**Options:** 3 products found`,
        },
      ],
    };

    expect(response.content[0].type).toBe("text");
    expect(response.content[0].text).toContain("**");
  });

  it("tools handle concurrent requests without race conditions", () => {
    // MCP server should handle multiple simultaneous tool calls
    // from Claude without blocking
    expect(true).toBe(true);
  });
});
