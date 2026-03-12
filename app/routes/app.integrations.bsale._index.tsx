import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useFetcher, useLoaderData, useNavigation, useRevalidator } from "react-router";
import { useEffect, useRef } from "react";
import { useSkuBeamNavigate } from "../lib/navigate";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";
import {
  createBsaleJob,
  getActiveBsaleJob,
} from "../integrations/bsale/jobs.server";

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const [shopRow, activeJob] = await Promise.all([
    supabaseAdmin
      .from("shops")
      .select("bsale_token, bsale_last_sync")
      .eq("shop_id", shopId)
      .single()
      .then(({ data }) => data),
    getActiveBsaleJob(shopId),
  ]);

  return {
    hasToken:      !!shopRow?.bsale_token,
    bsaleLastSync: shopRow?.bsale_last_sync ?? null,
    activeJob,
  };
};

// ── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId   = session.shop;
  const formData = await request.formData();
  const intent   = formData.get("intent") as string;

  // ── Save token ──────────────────────────────────────────────────────────────
  if (intent === "save_token") {
    const token = (formData.get("bsale_token") as string).trim();
    if (!token) return { error: "El token no puede estar vacío." };

    const { error } = await supabaseAdmin
      .from("shops")
      .update({ bsale_token: token })
      .eq("shop_id", shopId);

    if (error) return { error: `Error guardando token: ${error.message}` };
    return { success: "Token guardado correctamente." };
  }

  // ── Verify token exists before creating job ─────────────────────────────────
  const { data: shop } = await supabaseAdmin
    .from("shops")
    .select("bsale_token")
    .eq("shop_id", shopId)
    .single();

  if (!shop?.bsale_token && !process.env.BSALE_ACCESS_TOKEN) {
    return { error: "Configura el access token de Bsale antes de sincronizar." };
  }

  // ── Create job and return jobId immediately ─────────────────────────────────
  if (intent === "sync_products") {
    const job = await createBsaleJob(shopId, "bsale_products");
    return { jobId: job.id, jobType: "bsale_products" as const };
  }

  if (intent === "sync_stock") {
    const job = await createBsaleJob(shopId, "bsale_stock");
    return { jobId: job.id, jobType: "bsale_stock" as const };
  }

  return { error: "Acción desconocida." };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string | null) {
  if (!iso) return "Nunca";
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

function jobTypeLabel(type: string | null | undefined) {
  if (type === "bsale_products") return "productos";
  if (type === "bsale_stock")    return "stock";
  return "datos";
}

// ── UI ────────────────────────────────────────────────────────────────────────

export default function BsaleIntegrationPage() {
  const { hasToken, bsaleLastSync, activeJob } = useLoaderData<typeof loader>();
  const navigation  = useNavigation();
  const revalidator = useRevalidator();
  const navigate    = useSkuBeamNavigate();

  // Creates the job record — returns { jobId, jobType } immediately
  const createFetcher = useFetcher<{
    jobId?:   string;
    jobType?: "bsale_products" | "bsale_stock";
    error?:   string;
    success?: string;
  }>();

  // Triggers the actual background processing via /api/bsale/sync
  const triggerFetcher = useFetcher();

  // Polls /api/sync/status (unauthenticated — no ?shop=&host= needed)
  const statusFetcher = useFetcher<{
    status:            string | null;
    records_processed: number;
    type:              string | null;
  }>();

  const pollRef         = useRef<ReturnType<typeof setInterval> | null>(null);
  const triggeredJobRef = useRef<string | null>(null);

  // Resolve the active jobId: fresh from action, or from loader (page reload)
  const pendingJobId = createFetcher.data?.jobId ?? null;
  const jobId        = pendingJobId ?? activeJob?.id ?? null;
  const polledStatus = statusFetcher.data?.status;
  const isRunning    =
    !!jobId && polledStatus !== "completed" && polledStatus !== "failed";

  // When a new job is created, trigger the actual processing once
  useEffect(() => {
    if (!pendingJobId || triggeredJobRef.current === pendingJobId) return;
    triggeredJobRef.current = pendingJobId;
    triggerFetcher.submit(
      { jobId: pendingJobId },
      { method: "post", action: "/api/bsale/sync" },
    );
  }, [pendingJobId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll while a job is active
  useEffect(() => {
    if (!jobId) return;

    pollRef.current = setInterval(() => {
      statusFetcher.load(`/api/sync/status?jobId=${jobId}`);
    }, 3000);

    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  // When job finishes, stop polling and reload loader data
  useEffect(() => {
    if (polledStatus === "completed" || polledStatus === "failed") {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      revalidator.revalidate();
    }
  }, [polledStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const isSavingToken =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "save_token";

  const errorMsg =
    (createFetcher.data && "error" in createFetcher.data
      ? createFetcher.data.error
      : null) ??
    (polledStatus === "failed" ? "La sincronización falló. Revisa los logs." : null);

  const successMsg =
    createFetcher.data && "success" in createFetcher.data
      ? createFetcher.data.success
      : null;

  const progressLabel = statusFetcher.data?.records_processed
    ? ` — ${statusFetcher.data.records_processed} registros`
    : "";
  const runningType = statusFetcher.data?.type ?? activeJob?.type ?? null;

  return (
    <s-page heading="Integración Bsale">
      {/* ── Aside: status ── */}
      <s-section slot="aside" heading="Estado">
        <s-stack direction="block" gap="base">
          <s-badge tone={hasToken ? "success" : "warning"}>
            {hasToken ? "Token configurado" : "Sin token"}
          </s-badge>
          <s-text>
            Última sincronización: {formatDate(bsaleLastSync)}
          </s-text>
          <s-text>
            La autenticación Bsale se hace por header{" "}
            <code>access_token</code> en cada request. Obtén tu token desde
            el panel de Bsale → Configuración → API.
          </s-text>
        </s-stack>
      </s-section>

      {/* ── Main: feedback ── */}
      {successMsg && <s-banner tone="success" heading={successMsg} />}
      {errorMsg   && <s-banner tone="critical" heading={errorMsg} />}

      {/* ── Main: token config ── */}
      <s-section heading="Configuración de acceso">
        <Form method="post">
          <input type="hidden" name="intent" value="save_token" />
          <s-stack direction="block" gap="base">
            <s-text-field
              name="bsale_token"
              label="Access Token de Bsale"
              placeholder={hasToken ? "••••••••••••••••••••" : "Pega aquí tu access token"}
              help-text="El token se guarda de forma segura y nunca se envía al navegador."
            />
            <s-button
              type="submit"
              variant="secondary"
              {...(isSavingToken ? { loading: true } : {})}
            >
              {hasToken ? "Actualizar token" : "Guardar token"}
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      {/* ── Main: sync actions ── */}
      <s-section heading="Sincronización">
        <s-stack direction="block" gap="base">
          {!hasToken && (
            <s-banner
              tone="warning"
              heading="Configura el access token antes de sincronizar."
            />
          )}

          {/* Running job progress */}
          {isRunning && (
            <s-banner tone="info">
              <s-stack direction="inline" gap="small">
                <s-spinner />
                <s-text>
                  Sincronizando {jobTypeLabel(runningType)}{progressLabel}…
                </s-text>
              </s-stack>
            </s-banner>
          )}

          {/* Products */}
          <s-stack direction="block" gap="small">
            <s-heading>Productos</s-heading>
            <s-text>
              Importa el catálogo completo de variantes desde Bsale. Crea o
              actualiza SKUs por código. Respeta el costo promedio
              (averageCost) de cada variante.
            </s-text>
            <s-stack direction="inline" gap="small">
              <createFetcher.Form method="post">
                <input type="hidden" name="intent" value="sync_products" />
                <s-button
                  type="submit"
                  {...(isRunning || createFetcher.state !== "idle" ? { loading: true } : {})}
                  {...(!hasToken ? { disabled: true } : {})}
                >
                  Sincronizar productos desde Bsale
                </s-button>
              </createFetcher.Form>
              {hasToken && !isRunning && (
                <s-button
                  type="button"
                  variant="secondary"
                  onClick={() => navigate("/app/integrations/bsale/diff")}
                >
                  Revisar y publicar en Shopify →
                </s-button>
              )}
            </s-stack>
          </s-stack>

          {/* Stock */}
          <s-stack direction="block" gap="small">
            <s-heading>Stock</s-heading>
            <s-text>
              Actualiza los niveles de inventario por oficina Bsale. Requiere
              que los productos ya estén sincronizados (los SKUs deben existir
              en SkuBeam).
            </s-text>
            <createFetcher.Form method="post">
              <input type="hidden" name="intent" value="sync_stock" />
              <s-button
                type="submit"
                variant="secondary"
                {...(isRunning || createFetcher.state !== "idle" ? { loading: true } : {})}
                {...(!hasToken ? { disabled: true } : {})}
              >
                Sincronizar stock desde Bsale
              </s-button>
            </createFetcher.Form>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
