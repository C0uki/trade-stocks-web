import { z } from "zod";
import { json, requireUserId, route } from "@/lib/api";
import { placeOrder } from "@/lib/game/service";

const Body = z.object({
  instrumentId: z.number().int(),
  side: z.enum(["buy", "sell"]),
  account: z.enum(["cash", "margin", "future"]).optional(),
  action: z.enum(["open", "close"]).nullish(),
  type: z.enum(["market", "limit"]),
  limitPrice: z.number().positive().nullish(),
  amount: z.number().positive().nullish(),
  fraction: z.number().gt(0).lte(1).nullish(),
});

export const POST = route(async (req, ctx: RouteContext<"/api/scenarios/[id]/orders">) => {
  const { id } = await ctx.params;
  const userId = await requireUserId();
  const body = await json(req, Body);
  return { id: await placeOrder(id, userId, body) };
});
