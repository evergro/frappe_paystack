/**
 * Paystack checkout page.
 *
 * Reads its payload from a JSON script tag.
 */
(function () {
	"use strict";

	const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

	// Gateways set to this mode send the customer to a Paystack-hosted page.
	const HOSTED_MODE = "Hosted";

	const STATUS_TONES = {
		Pending: "pending",
		Processed: "success",
		"Needs Attention": "success",
		Completed: "success",
		Failed: "danger",
	};

	// Every captured status reads as paid to the customer.
	const STATUS_LABELS = {
		Pending: __("Awaiting payment"),
		Processed: __("Payment received"),
		"Needs Attention": __("Payment received"),
		Completed: __("Paid"),
		Failed: __("Payment failed"),
	};

	function readPayload() {
		const node = document.getElementById("paystack-checkout-data");
		if (!node) {
			return null;
		}
		try {
			return JSON.parse(node.textContent);
		} catch (error) {
			console.error("Paystack: could not parse checkout payload", error);
			return null;
		}
	}

	function formatMoney(amount, currency) {
		const value = Number(amount) || 0;
		try {
			return new Intl.NumberFormat(navigator.language || "en", {
				style: "currency",
				currency: currency,
				currencyDisplay: "narrowSymbol",
			}).format(value);
		} catch (error) {
			// Unknown/unsupported ISO code: fall back to a plain grouped number.
			return `${currency || ""} ${new Intl.NumberFormat(
				navigator.language || "en",
				{ minimumFractionDigits: 2, maximumFractionDigits: 2 }
			).format(value)}`.trim();
		}
	}

	const payload = readPayload();
	if (!payload) {
		return;
	}

	Vue.createApp({
		delimiters: ["[%", "%]"],

		data() {
			return {
				doc: payload,
				email: payload.email || "",
				emailTouched: false,
				busy: false,
				feedback: { message: "", tone: "info" },
				// A subscription must keep the card for next month's charge.
				saveCard: payload.variant === "subscription",
				consent: payload.variant !== "subscription",
			};
		},

		computed: {
			isSubscription() {
				return this.doc.variant === "subscription";
			},

			payLabel() {
				return this.isSubscription
					? __("Subscribe")
					: __("Pay {0}", [formatMoney(this.doc.payment_amount, this.doc.currency)]);
			},
			heading() {
				return this.isSubscription
					? __("Complete your subscription")
					: __("Complete your payment");
			},

			planBadge() {
				return this.isSubscription
					? __("Monthly subscription")
					: __("One-time payment");
			},

			busyLabel() {
				return this.busy ? __("Processing...") : this.payLabel;
			},
			formattedChargeAmount() {
				return formatMoney(this.doc.payment_amount, this.doc.currency);
			},

			formattedOrderTotal() {
				return formatMoney(this.doc.grand_total, this.doc.order_currency);
			},

			showConverted() {
				return this.doc.order_currency !== this.doc.currency;
			},

			exchangeRate() {
				return Number(this.doc.exchange_rate || 1).toFixed(4);
			},

			statusTone() {
				return STATUS_TONES[this.doc.status] || "pending";
			},

			statusLabel() {
				return STATUS_LABELS[this.doc.status] || this.doc.status;
			},

			canPay() {
				return Boolean(this.doc.is_payable);
			},

			needsEmail() {
				return !payload.email;
			},

			isEmailValid() {
				return EMAIL_PATTERN.test(this.email || "");
			},

			canSubmit() {
				return !this.busy && this.isEmailValid && this.consent;
			},

			closedReason() {
				if (["Processed", "Needs Attention", "Completed"].includes(this.doc.status)) {
					return __("This payment has already been completed. No further action is needed.");
				}
				if (this.doc.is_expired) {
					return __("This payment link has expired. Please request a new one.");
				}
				if (!this.doc.is_payable) {
					return __("The related document is no longer active, so it cannot be paid.");
				}
				return __("This document has been settled and is no longer payable.");
			},
		},

		methods: {
			money(amount) {
				return formatMoney(amount, this.doc.order_currency || this.doc.currency);
			},
			setFeedback(message, tone) {
				this.feedback = { message: message, tone: tone || "info" };
			},
			async startPayment() {
				if (!this.canSubmit) {
					this.emailTouched = true;
					return;
				}

				this.busy = true;
				this.setFeedback("", "info");

				// Re-reads the link server-side.
				const fresh = await this.fetchStatus();
				if (!fresh) {
					this.busy = false;
					return;
				}

				this.doc = Object.assign({}, this.doc, fresh);
				if (!this.doc.is_payable) {
					this.busy = false;
					this.setFeedback(this.closedReason, "warning");
					return;
				}

				// Store what the customer agreed to before the popup opens.
				try {
					await frappe.call({
						method: "frappe_paystack.api.record_consent",
						args: {
							reference: this.doc.reference,
							save_card: this.saveCard ? 1 : 0,
							consent: this.consent ? 1 : 0,
						},
					});
				} catch (error) {
					this.busy = false;
					this.setFeedback(
						(error && error.message) || __("We could not save your choices. Please try again."),
						"danger"
					);
					return;
				}

				if (this.doc.checkout_mode === HOSTED_MODE) {
					this.openHostedCheckout();
					return;
				}

				this.openPaystack();
			},

			fetchStatus() {
				return frappe
					.call("frappe_paystack.api.validate_payment_link", {
						docname: this.doc.reference,
					})
					.then((res) => res.message)
					.catch(() => {
						this.setFeedback(
							__("We could not reach the server. Please try again."),
							"danger"
						);
						return null;
					});
			},

			openHostedCheckout() {
				const self = this;

				return frappe
					.call("frappe_paystack.api.start_hosted_checkout", {
						reference: this.doc.reference,
						email: this.email,
					})
					.then((res) => {
						if (!res.message) {
							self.busy = false;
							self.setFeedback(
								__("We could not open the payment page. Please try again."),
								"danger"
							);
							return;
						}
						window.location.href = res.message;
					})
					.catch(() => {
						self.busy = false;
						self.setFeedback(
							__("We could not reach the server. Please try again."),
							"danger"
						);
					});
			},

			openPaystack() {
				const self = this;
				const popup = new PaystackPop();

				popup.newTransaction({
					key: this.doc.public_key,
					email: this.email,
					// Paystack expects the amount in minor units.
					amount: Math.round(Number(this.doc.payment_amount) * 100),
					currency: this.doc.currency,
					reference: this.doc.reference,
					// The webhook finds the Payment Log through metadata.reference.
					metadata: {
						reference: this.doc.reference,
						email: this.email,
					},
					onSuccess() {
						self.busy = false;
						self.doc = Object.assign({}, self.doc, {
							status: "Processed",
							is_payable: false,
						});
						self.setFeedback(
							__("Payment received. Your receipt will arrive by email shortly."),
							"success"
						);
					},
					onCancel() {
						self.busy = false;
						self.setFeedback(__("Payment cancelled. You can try again."), "warning");
					},
					onError(error) {
						self.busy = false;
						self.setFeedback(
							(error && error.message) ||
								__("The payment could not be completed. Please try again."),
							"danger"
						);
					},
				});
        
			},
		},
	}).mount("#paystack-checkout");
})();