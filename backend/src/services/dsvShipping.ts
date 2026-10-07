import { config } from "../config.js";
import type { AddressInfo } from "../store/types.js";

/**
 * DSV Connect Booking API (Road transport mode) sandbox integration for the
 * Fulfillment Agent (see agents/fulfillmentAgent.ts). Only ever initialized
 * with sandbox credentials from the DSV developer portal
 * (https://developer.dsv.com/) — config.dsvClientId/dsvClientSecret/
 * dsvSubscriptionKey. When those aren't configured (config.isDemoFulfillment),
 * fulfillmentAgent falls back to a local simulated shipment instead of
 * calling this module.
 *
 * NOTE: the exact Booking API request/response field names below follow
 * DSV's publicly described Connect Booking API shape (shipper/consignee/
 * colli lines, Booking Party & Freight Payer via an MDM account number,
 * autobook flag). DSV's full OpenAPI schema is only visible once logged
 * into the developer portal with an approved subscription — verify field
 * names against your own subscription's OAS3 spec/Postman collection and
 * adjust `bookShipment`'s payload shape if it differs.
 */

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let cachedToken: CachedToken | null = null;

/** OAuth2 client-credentials grant, cached in-memory until shortly before
 * expiry so we don't fetch a new token on every booking. */
async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.accessToken;
  }

  const response = await fetch(config.dsvTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.dsvClientId,
      client_secret: config.dsvClientSecret,
    }),
  });

  if (!response.ok) {
    throw new Error(`DSV OAuth2 token request failed (${response.status}): ${await response.text()}`);
  }

  const body = (await response.json()) as { access_token: string; expires_in?: number };
  cachedToken = {
    accessToken: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return cachedToken.accessToken;
}

export interface BookShipmentInput {
  /** Our internal order number (e.g. "ORD-000042"), used as the shipper's
   * own reference on the booking. */
  orderNumber: string;
  /** Recipient (consignee) address — the customer's shipping (or billing,
   * as a fallback) address on file. */
  recipient: AddressInfo;
  /** Number of line items, used to size the colli/package count. */
  itemCount: number;
}

export interface BookShipmentResult {
  carrier: "DSV";
  trackingNumber: string;
  bookingReference: string;
}

/**
 * Books a Road shipment with DSV's sandbox Booking API using the configured
 * fixed warehouse sender address and default package weight/dimensions
 * (config.dsvSender / config.dsvDefaultPackage — see config.ts for why
 * these are hackathon simplifications rather than per-order data). Submits
 * directly (`autobook: true`) rather than creating a MyDSV draft.
 *
 * Throws on any HTTP/validation failure — the caller (fulfillmentAgent) is
 * expected to catch this and fall back to a simulated shipment so a DSV
 * sandbox hiccup never hard-fails the order pipeline.
 */
export async function bookShipment(input: BookShipmentInput): Promise<BookShipmentResult> {
  const { orderNumber, recipient, itemCount } = input;
  const token = await getAccessToken();
  const sender = config.dsvSender;
  const pkg = config.dsvDefaultPackage;

  const payload = {
    transportMode: "ROAD",
    autobook: true,
    bookingParty: { accountNumber: config.dsvAccountNumber },
    freightPayer: { accountNumber: config.dsvAccountNumber },
    shipperReference: orderNumber,
    shipper: {
      name: sender.name,
      address: { street: sender.street, city: sender.city, zipCode: sender.zip, countryCode: sender.country },
      contact: { phone: sender.phone, email: sender.email },
    },
    consignee: {
      name: recipient.companyName ?? "",
      address: {
        street: recipient.street ?? "",
        city: recipient.city ?? "",
        zipCode: recipient.zipCode ?? "",
        countryCode: recipient.country ?? "",
      },
      contact: { phone: recipient.phone ?? "", email: recipient.email ?? "" },
    },
    goods: [
      {
        colliCount: Math.max(1, itemCount),
        weightKg: pkg.weightKg,
        lengthCm: pkg.lengthCm,
        widthCm: pkg.widthCm,
        heightCm: pkg.heightCm,
      },
    ],
  };

  const response = await fetch(`${config.dsvApiBaseUrl}/bookings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "Ocp-Apim-Subscription-Key": config.dsvSubscriptionKey,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`DSV booking request failed (${response.status}): ${await response.text()}`);
  }

  const body = (await response.json()) as {
    bookingReference?: string;
    trackingNumber?: string;
    shipmentId?: string;
  };

  const bookingReference = body.bookingReference ?? body.shipmentId ?? "";
  const trackingNumber = body.trackingNumber ?? bookingReference;

  if (!trackingNumber) {
    throw new Error("DSV booking response did not include a tracking number or booking reference.");
  }

  return { carrier: "DSV", trackingNumber, bookingReference: bookingReference || trackingNumber };
}
