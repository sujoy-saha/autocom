import { v4 as uuid } from "uuid";
import { db } from "../store/index.js";
import { config } from "../config.js";
import * as dsvShipping from "../services/dsvShipping.js";
import type { OrderState } from "../graph/state.js";
import type { AddressInfo } from "../store/types.js";

const CARRIERS = ["FastShip", "ParcelPro", "NordicPost"];

function simulateShipment(): { carrier: string; trackingNumber: string } {
  const carrier = CARRIERS[Math.floor(Math.random() * CARRIERS.length)];
  const trackingNumber = `${carrier.slice(0, 2).toUpperCase()}-${uuid().slice(0, 10)}`;
  return { carrier, trackingNumber };
}

function hasUsableAddress(address: AddressInfo | null | undefined): address is AddressInfo {
  return !!address && !!address.street && !!address.city && !!address.country;
}

/**
 * Fulfillment Agent: books a Road shipment via DSV's real sandbox Connect
 * Booking API (see services/dsvShipping.ts) for a paid order, using the
 * customer's shipping (or billing, as fallback) address on file. Falls back
 * to a simulated carrier/tracking number (as before) when DSV sandbox
 * credentials aren't configured (config.isDemoFulfillment), when the order
 * has no usable recipient address (e.g. free-text chat orders that never
 * captured one), or when the DSV API call itself fails — a carrier sandbox
 * hiccup should never hard-fail the demo order pipeline.
 */
export async function fulfillmentAgent(state: OrderState): Promise<Partial<OrderState>> {
  let carrier: string;
  let trackingNumber: string;

  if (config.isDemoFulfillment) {
    ({ carrier, trackingNumber } = simulateShipment());
  } else {
    const { customer } = await db.getOrderDetails(state.orderId);
    const recipient = customer?.shipping_address ?? customer?.billing_address ?? null;

    if (!hasUsableAddress(recipient)) {
      await db.logAgentStep(
        state.orderId,
        "fulfillment",
        "dsv_booking_skipped",
        "No shipping/billing address on file for this order's customer — falling back to a simulated shipment."
      );
      ({ carrier, trackingNumber } = simulateShipment());
    } else {
      try {
        const booked = await dsvShipping.bookShipment({
          orderNumber: state.orderNumber,
          recipient,
          itemCount: state.items.length,
        });
        carrier = booked.carrier;
        trackingNumber = booked.trackingNumber;
      } catch (err) {
        await db.logAgentStep(
          state.orderId,
          "fulfillment",
          "dsv_booking_failed",
          `DSV booking failed, falling back to a simulated shipment: ${(err as Error).message}`
        );
        ({ carrier, trackingNumber } = simulateShipment());
      }
    }
  }

  const shipment = await db.insertShipment({
    orderId: state.orderId,
    carrier,
    trackingNumber,
    status: "shipped",
  });

  await db.updateOrder(state.orderId, { status: "fulfilled" });

  await db.logAgentStep(
    state.orderId,
    "fulfillment",
    "shipment_booked",
    `Booked with ${carrier}, tracking ${trackingNumber}`
  );

  return { shipmentId: shipment.id, trackingNumber, status: "fulfilled" };
}
