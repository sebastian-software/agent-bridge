import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { QualificationEvidence, RouteDescriptor } from "./contract.js";

import { BridgeError } from "./errors.js";

export type UserModelDefinition = {
  readonly nativeModel: string;
  readonly efforts?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly interactionStrategies?: RouteDescriptor["interactionStrategies"];
};

export type UserAdapterCatalog = {
  readonly aliases?: Readonly<Record<string, string>>;
  readonly models?: Readonly<Record<string, UserModelDefinition>>;
};

export type UserModelCatalog = {
  readonly adapters?: Readonly<Record<string, UserAdapterCatalog>>;
};

export function defaultCatalogPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return process.env.HARNESS_RELAY_CONFIG_PATH ?? join(configHome, "harness-relay", "config.json");
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry !== "")
    ? value
    : undefined;
}

function parseCatalog(value: unknown, path: string): UserModelCatalog {
  const root = object(value);
  const adapters = root?.adapters === undefined ? undefined : object(root.adapters);
  if (root === undefined || (root.adapters !== undefined && adapters === undefined)) {
    throw new BridgeError({
      code: "invalid_request",
      message: `Model catalog ${path} must contain an adapters object.`,
      retryable: false,
    });
  }
  const parsedAdapters: Record<string, UserAdapterCatalog> = {};
  for (const [adapterId, rawAdapter] of Object.entries(adapters ?? {})) {
    const adapter = object(rawAdapter);
    if (adapter === undefined) {
      throw new BridgeError({
        code: "invalid_request",
        message: `Model catalog adapter ${adapterId} must be an object.`,
        retryable: false,
      });
    }
    const aliases = adapter.aliases === undefined ? undefined : object(adapter.aliases);
    if (
      adapter.aliases !== undefined &&
      (aliases === undefined ||
        !Object.values(aliases).every((value) => typeof value === "string" && value !== ""))
    ) {
      throw new BridgeError({
        code: "invalid_request",
        message: `Model catalog aliases for ${adapterId} must map strings to strings.`,
        retryable: false,
      });
    }
    const modelsSource = adapter.models === undefined ? undefined : object(adapter.models);
    if (adapter.models !== undefined && modelsSource === undefined) {
      throw new BridgeError({
        code: "invalid_request",
        message: `Model catalog models for ${adapterId} must be an object.`,
        retryable: false,
      });
    }
    const models: Record<string, UserModelDefinition> = {};
    for (const [modelId, rawModel] of Object.entries(modelsSource ?? {})) {
      const model = object(rawModel);
      if (
        model === undefined ||
        typeof model.nativeModel !== "string" ||
        model.nativeModel === ""
      ) {
        throw new BridgeError({
          code: "invalid_request",
          message: `Model catalog entry ${adapterId}/${modelId} needs nativeModel.`,
          retryable: false,
        });
      }
      const efforts = model.efforts === undefined ? undefined : stringArray(model.efforts);
      const capabilities =
        model.capabilities === undefined ? undefined : stringArray(model.capabilities);
      const interactionStrategies =
        model.interactionStrategies === undefined
          ? undefined
          : stringArray(model.interactionStrategies);
      if (
        (model.efforts !== undefined && efforts === undefined) ||
        (model.capabilities !== undefined && capabilities === undefined) ||
        (model.interactionStrategies !== undefined && interactionStrategies === undefined)
      ) {
        throw new BridgeError({
          code: "invalid_request",
          message: `Model catalog entry ${adapterId}/${modelId} contains an invalid list.`,
          retryable: false,
        });
      }
      models[modelId] = {
        nativeModel: model.nativeModel,
        ...(efforts === undefined ? {} : { efforts }),
        ...(capabilities === undefined ? {} : { capabilities }),
        ...(interactionStrategies === undefined
          ? {}
          : {
              interactionStrategies:
                interactionStrategies as RouteDescriptor["interactionStrategies"],
            }),
      };
    }
    parsedAdapters[adapterId] = {
      ...(aliases === undefined ? {} : { aliases: aliases as Record<string, string> }),
      ...(Object.keys(models).length === 0 ? {} : { models }),
    };
  }
  return Object.keys(parsedAdapters).length === 0 ? {} : { adapters: parsedAdapters };
}

export async function loadUserModelCatalog(path = defaultCatalogPath()): Promise<UserModelCatalog> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw new BridgeError(
      {
        code: "invalid_request",
        message: `Model catalog ${path} could not be read.`,
        retryable: false,
      },
      { cause: error },
    );
  }
  try {
    return parseCatalog(JSON.parse(text) as unknown, path);
  } catch (error) {
    if (error instanceof BridgeError) {
      throw error;
    }
    throw new BridgeError(
      {
        code: "invalid_request",
        message: `Model catalog ${path} is not valid JSON.`,
        retryable: false,
      },
      { cause: error },
    );
  }
}

function userEvidence(
  adapterId: string,
  modelId: string,
  nativeModel: string,
  runtimeId?: string,
  runtimeRevision?: string,
): QualificationEvidence {
  const runtimeSuffix =
    runtimeId === undefined
      ? ""
      : `:runtime:${runtimeId}${runtimeRevision === undefined ? "" : `@${runtimeRevision}`}`;
  return {
    qualificationId: `user-declared:${adapterId}${runtimeSuffix}:${modelId}`,
    testedAt: new Date().toISOString(),
    claim: `User-declared model ${modelId} maps to native model ${nativeModel}; runtime support is not independently qualified.`,
  };
}

function routeWithModel(
  route: RouteDescriptor,
  model: string,
  canonicalModel: string,
  catalog: undefined | UserModelDefinition,
  adapterId: string,
): RouteDescriptor {
  const connectionSuffix =
    route.connectionId === undefined || route.connectionRevision === undefined
      ? ""
      : `:connection:${route.connectionId}@${route.connectionRevision}`;
  const routeId =
    route.runtimeId === undefined
      ? `${route.adapter}:${model}${connectionSuffix}`
      : `${route.routeId}:alias:${encodeURIComponent(model)}`;
  return {
    ...route,
    routeId,
    model,
    canonicalModel,
    ...(catalog?.nativeModel === undefined ? {} : { nativeModel: catalog.nativeModel }),
    ...(catalog?.efforts === undefined ? {} : { efforts: catalog.efforts }),
    ...(catalog?.capabilities === undefined ? {} : { capabilities: catalog.capabilities }),
    ...(catalog?.interactionStrategies === undefined
      ? {}
      : { interactionStrategies: catalog.interactionStrategies }),
    qualification: [
      ...route.qualification,
      userEvidence(
        adapterId,
        model,
        catalog?.nativeModel ?? canonicalModel,
        route.runtimeId,
        route.runtimeRevision,
      ),
    ],
  };
}

export function applyUserModelCatalog(
  routes: readonly RouteDescriptor[],
  catalog: UserModelCatalog,
): readonly RouteDescriptor[] {
  const result = [...routes];
  for (const [adapterId, adapterCatalog] of Object.entries(catalog.adapters ?? {})) {
    const adapterRoutes = routes.filter((route) => route.adapter === adapterId);
    const groups = new Map<string, RouteDescriptor[]>();
    for (const route of adapterRoutes) {
      const groupKey = JSON.stringify([
        route.connectionId,
        route.runtimeId,
        route.runtimeRevision,
        route.inferenceServer,
      ]);
      const group = groups.get(groupKey) ?? [];
      group.push(route);
      groups.set(groupKey, group);
    }

    for (const group of groups.values()) {
      const connectionId = group[0]?.connectionId;
      const runtimeId = group[0]?.runtimeId;
      const runtimeRevision = group[0]?.runtimeRevision;
      const hasModel = (modelId: string): boolean =>
        result.some(
          (route) =>
            route.adapter === adapterId &&
            route.connectionId === connectionId &&
            route.runtimeId === runtimeId &&
            route.runtimeRevision === runtimeRevision &&
            route.model === modelId,
        );
      for (const [alias, target] of Object.entries(adapterCatalog.aliases ?? {})) {
        const targetRoute = group.find(
          (route) => route.model === target || route.canonicalModel === target,
        );
        if (targetRoute !== undefined && !hasModel(alias)) {
          result.push(
            routeWithModel(
              targetRoute,
              alias,
              targetRoute.canonicalModel ?? targetRoute.model,
              { nativeModel: targetRoute.nativeModel ?? targetRoute.model },
              adapterId,
            ),
          );
        }
      }
      const template = group[0];
      if (template === undefined || template.runtimeId !== undefined) {
        continue;
      }
      for (const [modelId, definition] of Object.entries(adapterCatalog.models ?? {})) {
        if (!hasModel(modelId)) {
          result.push(
            routeWithModel(template, modelId, definition.nativeModel, definition, adapterId),
          );
        }
      }
    }
  }
  return result;
}
