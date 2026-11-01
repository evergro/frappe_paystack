"""What the public checkout page shows about the customer, without the backend ids."""

from typing import Any, Optional

import frappe

from frappe.utils import flt, formatdate, getdate, strip_html, fmt_money

# ERPNext has no "service" Address type; this is the one a service address is filed under.
BILLING_ADDRESS_TYPE = "Billing"
SERVICE_ADDRESS_TYPE = "Shipping"

DOCUMENT_LABELS = {
    "Sales Invoice": "Invoice",
    "Sales Order": "Order",
    "Dunning": "Payment reminder",
    "POS Invoice": "Receipt",
}


def customer_name(customer: Optional[str]) -> str:
    """Return the name a customer is known by, never their id."""
    if not customer:
        return ""
    return frappe.db.get_value("Customer", customer, "customer_name") or ""


def address_text(customer: Optional[str], address_type: str) -> str:
    """Return the customer's newest enabled address of a type, as one line."""
    if not customer:
        return ""

    names = frappe.get_all(
        "Dynamic Link",
        filters={"parenttype": "Address", "link_doctype": "Customer", "link_name": customer},
        pluck="parent",
    )
    if not names:
        return ""

    rows = frappe.get_all(
        "Address",
        filters={"name": ["in", names], "disabled": 0, "address_type": address_type},
        fields=["address_line1", "city", "pincode"],
        order_by="modified desc",
        limit_page_length=1,
    )
    if not rows:
        return ""

    return ", ".join(part for part in (rows[0].address_line1, rows[0].city, rows[0].pincode) if part)


def is_subscription(order: Any) -> bool:
    """Report whether the document is an invoice an ERPNext Subscription raised."""
    return bool(order.get("subscription"))


def order_lines(order: Any) -> list:
    """Return the document's items as the customer reads them: name, short note, quantity, amount."""
    lines = []
    for row in order.get("items") or []:
        name = row.item_name or row.item_code
        note = " ".join(strip_html(row.description or "").split())
        lines.append(
            {
                "name": name,
                "description": "" if note == name else note[:90],
                "qty": flt(row.qty),
                "amount": flt(row.amount),
                "amount_text": fmt_money(flt(row.amount), currency=order.currency),
            }
        )
    return lines


def document_label(order: Any) -> str:
    """Return the document's number and date, e.g. INV-1048 · 20 June 2025."""
    posted = order.get("posting_date") or order.get("transaction_date")
    return f"{order.name} · {formatdate(getdate(posted), 'd MMMM yyyy')}" if posted else order.name


def checkout_view(company: str, order: Any) -> dict:
    """Return the customer-facing details the checkout page adds to the amounts."""
    customer = order.get("customer")
    return {
        "company_name": frappe.db.get_value("Company", company, "company_name") or company,
        "customer_name": customer_name(customer),
        "mobile": (frappe.db.get_value("Customer", customer, "mobile_no") if customer else "") or "",
        "variant": "subscription" if is_subscription(order) else "one_off",
        "description": DOCUMENT_LABELS.get(order.doctype, order.doctype),
        "document_label": document_label(order),
        "lines": order_lines(order),
        "subtotal": flt(order.get("total")),
        "subtotal_text": fmt_money(flt(order.get("total")), currency=order.currency),
        "discount": flt(order.get("discount_amount")),
        "discount_text": fmt_money(flt(order.get("discount_amount")), currency=order.currency),
        "taxes": flt(order.get("total_taxes_and_charges")),
        "taxes_text": fmt_money(flt(order.get("total_taxes_and_charges")), currency=order.currency),
        "billing_address": address_text(customer, BILLING_ADDRESS_TYPE),
        "service_address": address_text(customer, SERVICE_ADDRESS_TYPE),
    }