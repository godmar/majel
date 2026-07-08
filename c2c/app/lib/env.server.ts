import path from "node:path";
import { config } from "dotenv";
import { z } from "zod";

// In dev the shared .env lives at the repo root; in the container it is
// provided by the environment, so missing files are fine.
config({
  path: [path.resolve(process.cwd(), "../.env"), path.resolve(process.cwd(), ".env")],
  quiet: true,
});

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  DATABASE_URL: z.string(),
  SESSION_SECRET: z.string().min(16),

  CAS_LOGIN_URL: z.string(),
  CAS_SERVICE_URL: z.string(),
  CAS_SERVICE_VALIDATE_URL: z.string(),
  ADMIN_ACCOUNTS: z.string().default(""),

  CC_BEARER_TOKEN: z.string().min(16),
  CC_BEARER_URL: z.string().default("http://localhost:3000"),
  CC_INTERNAL_URL: z.string().optional(),

  KUBECONFIG: z.string().optional(),
  K8S_NAMESPACE: z.string().default("vtlib"),
  SANDBOX_CONTAINER_IMAGE: z.string().default(""),
  // Optional placement constraint for agent pods: "key=value,key2=value2".
  SANDBOX_NODE_SELECTOR: z.string().default(""),

  LLM_API_BASE_URL: z.string().default(""),

  DEV_FAKE_USER: z.string().optional(),
});

export const env = schema.parse(process.env);

export const adminAccounts = env.ADMIN_ACCOUNTS.split(",")
  .map((a) => a.trim())
  .filter(Boolean);

export const isProduction = env.NODE_ENV === "production";
