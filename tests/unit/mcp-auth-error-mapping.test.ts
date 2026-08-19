/**
 * #556: the MCP layer mapped EVERY 401 to "the API key is invalid or revoked —
 * re-provision it". A buyer's failed catalog search was then misdiagnosed as a
 * dead key (and relayed to the user as a fake "service updating" outage) when
 * the actual failure can be a missing header, or an API key sent to a JWT-only
 * user-session route (INVALID_TOKEN) where the key is perfectly valid and
 * re-provisioning is exactly the wrong move. The mapping now tells these apart
 * by the code the API actually returned.
 */
import { describe, it, expect } from "vitest";
import { ApiError, toErrorMessage } from "../../src/mcp/tools.js";

const err = (status: number, code: string | null, message = "boom") =>
    new ApiError(message, status, code ? { code } : {});

describe("MCP auth error mapping (#556)", () => {
    it("a genuinely bad key still says re-provision", () => {
        for (const code of ["INVALID_KEY", "INVALID_KEY_FORMAT"]) {
            const m = toErrorMessage(err(401, code));
            expect(m).toContain("invalid or revoked");
            expect(m).toContain("re-provisioned");
        }
    });

    it("an API key rejected by a JWT-only route must NOT say re-provision", () => {
        const m = toErrorMessage(err(401, "INVALID_TOKEN"));
        expect(m).toContain("do NOT re-provision");
        expect(m).not.toContain("must be re-provisioned");
        expect(m).toContain("user-session endpoint");
    });

    // commerce#824: an expired OAuth grant is NOT a revoked key. The old
    // mapping told the operator to re-provision a credential that only needed
    // a refresh — and the agent relayed "your key is revoked" to the seller.
    it("an expired OAuth grant says re-authorize, never re-provision", () => {
        const m = toErrorMessage(err(401, "EXPIRED_KEY"));
        expect(m.toLowerCase()).toContain("expired");
        expect(m).toContain("re-authoriz");
        expect(m).not.toContain("re-provisioned");
        expect(m).not.toContain("invalid or revoked");
    });

    it("missing credentials point at integration config, not a dead key", () => {
        const m = toErrorMessage(err(401, "MISSING_AUTH"));
        expect(m).toContain("missing Authorization header");
        expect(m).not.toContain("re-provisioned");
    });

    it("an unrecognized 401 carries the server's code and message instead of guessing", () => {
        const m = toErrorMessage(err(401, "SOME_NEW_CODE", "session expired"));
        expect(m).toContain("SOME_NEW_CODE");
        expect(m).toContain("session expired");
        expect(m).not.toContain("re-provisioned");
    });

    it("every auth branch still says no search was performed (anti-fabrication)", () => {
        for (const code of ["INVALID_KEY", "INVALID_TOKEN", "MISSING_AUTH", "OTHER"]) {
            expect(toErrorMessage(err(401, code))).toMatch(/no search was performed/i);
        }
    });

    it("non-auth errors pass through untouched", () => {
        expect(toErrorMessage(err(500, "INTERNAL", "database exploded"))).toBe("database exploded");
    });
});
