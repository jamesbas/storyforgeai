import type {
  WangpJob,
  WangpModel,
  WangpModelSchema,
} from "@/lib/schemas/wangp";

/**
 * WanGP MCP client interface. The application talks only to this interface; a
 * mock client backs demo/local mode and tests, and a real MCP client is used
 * when WANGP_MCP_ENABLED is set (generic-build-spec External System Connector +
 * Mock Layer).
 */
export interface WangpClient {
  readonly mode: "mock" | "live";
  listModels(mainOutput?: "image" | "video" | "audio"): Promise<WangpModel[]>;
  getModelSchema(modelType: string): Promise<WangpModelSchema>;
  generate(settings: Record<string, unknown>): Promise<WangpJob>;
  getJob(jobId: string): Promise<WangpJob>;
  cancelJob(jobId: string): Promise<WangpJob>;
  health(): Promise<boolean>;
}
