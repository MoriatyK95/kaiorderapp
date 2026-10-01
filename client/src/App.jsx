import { useEffect, useRef, useState } from 'react';

const MAX_QUANTITY = 99;
const money = new Intl.NumberFormat('en-SG', {
  style: 'currency',
  currency: 'SGD',
});
const formatMoney = (cents) => money.format(cents / 100);

export default function App() {
  const [menu, setMenu] = useState([]);
  const [menuLoading, setMenuLoading] = useState(true);
  const [menuError, setMenuError] = useState('');
  const [menuAttempt, setMenuAttempt] = useState(0);
  const [cart, setCart] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [orderError, setOrderError] = useState('');
  const [confirmation, setConfirmation] = useState(null);
  const submissionPending = useRef(false);

  useEffect(() => {
    const controller = new AbortController();

    async function loadMenu() {
      setMenuLoading(true);
      setMenuError('');

      try {
        const response = await fetch('/api/menu', { signal: controller.signal });
        if (!response.ok) throw new Error('Menu request failed.');
        const data = await response.json();
        if (!controller.signal.aborted) setMenu(data.items);
      } catch (error) {
        if (!controller.signal.aborted) {
          setMenuError('We couldn’t load the menu. Please try again.');
        }
      } finally {
        if (!controller.signal.aborted) setMenuLoading(false);
      }
    }

    loadMenu();
    return () => controller.abort();
  }, [menuAttempt]);

  const cartItems = menu
    .filter((item) => cart[item.id])
    .map((item) => ({ ...item, quantity: cart[item.id] }));
  const itemCount = cartItems.reduce((count, item) => count + item.quantity, 0);
  const totalCents = cartItems.reduce(
    (total, item) => total + item.priceCents * item.quantity,
    0,
  );

  function changeQuantity(id, change) {
    if (submissionPending.current) return;
    setOrderError('');
    setConfirmation(null);
    setCart((current) => {
      const quantity = Math.max(0, Math.min(MAX_QUANTITY, (current[id] || 0) + change));
      const next = { ...current };
      if (quantity === 0) delete next[id];
      else next[id] = quantity;
      return next;
    });
  }

  function removeItem(id) {
    if (submissionPending.current) return;
    setOrderError('');
    setConfirmation(null);
    setCart((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  async function submitOrder(event) {
    event.preventDefault();
    if (submissionPending.current || cartItems.length === 0) return;

    submissionPending.current = true;
    setSubmitting(true);
    setOrderError('');
    setConfirmation(null);

    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cartItems.map(({ id, quantity }) => ({ id, quantity })),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'We couldn’t submit your demo order. Please try again.');
      }

      setConfirmation(data);
      setCart({});
    } catch (error) {
      setOrderError(
        error instanceof TypeError || error instanceof SyntaxError
          ? 'We couldn’t reach the ordering service. Please try again.'
          : error.message,
      );
    } finally {
      submissionPending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="KaiOrderApp home">
          <span className="brand-mark" aria-hidden="true">k.</span>
          <span>KaiOrderApp</span>
        </a>
        <span className="demo-label"><span aria-hidden="true" />Demo kitchen</span>
      </header>

      <main>
        <section className="introduction" aria-labelledby="page-title">
          <p className="eyebrow">A small menu. A simple order.</p>
          <h1 id="page-title">Good food.<br /><span>Easy choices.</span></h1>
          <p className="intro-copy">Pick something you like, make it a meal, and give demo ordering a try.</p>
        </section>

        <div className="ordering-layout">
          <section className="menu-section" aria-labelledby="menu-title" aria-busy={menuLoading}>
            <div className="section-heading">
              <h2 id="menu-title">The menu</h2>
              <span>Prices in SGD</span>
            </div>

            {menuLoading && <p className="menu-message" role="status">Preparing the menu…</p>}
            {menuError && (
              <div className="menu-message error-message" role="alert">
                <p>{menuError}</p>
                <button className="secondary-button" onClick={() => setMenuAttempt((attempt) => attempt + 1)}>
                  Try again
                </button>
              </div>
            )}
            {!menuLoading && !menuError && (
              <ul className="menu-grid">
                {menu.map((item, index) => (
                  <li className="menu-card" key={item.id}>
                    <span className="dish-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                    <h3>{item.name}</h3>
                    <div className="dish-actions">
                      <span className="dish-price">{formatMoney(item.priceCents)}</span>
                      <button
                        className="add-button"
                        aria-label={`Add ${item.name}`}
                        disabled={submitting || cart[item.id] >= MAX_QUANTITY}
                        onClick={() => changeQuantity(item.id, 1)}
                      >
                        <span aria-hidden="true">+</span> Add
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <aside className="cart-panel" aria-labelledby="cart-title">
            <div className="cart-heading">
              <h2 id="cart-title">Your order</h2>
              <span className="item-count" aria-live="polite" aria-atomic="true">
                {itemCount} {itemCount === 1 ? 'item' : 'items'}
              </span>
            </div>

            <form onSubmit={submitOrder}>
              {cartItems.length === 0 ? (
                <div className="empty-cart">
                  <span className="empty-cart-mark" aria-hidden="true">+</span>
                  <p>A good meal starts here.</p>
                  <span>Add a dish from the menu to get started.</span>
                </div>
              ) : (
                <ul className="cart-items">
                  {cartItems.map((item) => (
                    <li className="cart-item" key={item.id}>
                      <div className="cart-item-heading">
                        <h3>{item.name}</h3>
                        <span>{formatMoney(item.priceCents * item.quantity)}</span>
                      </div>
                      <p className="unit-price">{formatMoney(item.priceCents)} each</p>
                      <div className="cart-item-controls">
                        <div className="quantity-control" role="group" aria-label={`${item.name} quantity`}>
                          <button
                            type="button"
                            aria-label={`Decrease ${item.name} quantity`}
                            disabled={submitting}
                            onClick={() => changeQuantity(item.id, -1)}
                          >−</button>
                          <span aria-label={`${item.quantity} ${item.name}`}>{item.quantity}</span>
                          <button
                            type="button"
                            aria-label={`Increase ${item.name} quantity`}
                            disabled={submitting || item.quantity >= MAX_QUANTITY}
                            onClick={() => changeQuantity(item.id, 1)}
                          >+</button>
                        </div>
                        <button
                          className="remove-button"
                          type="button"
                          aria-label={`Remove ${item.name}`}
                          disabled={submitting}
                          onClick={() => removeItem(item.id)}
                        >Remove</button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="cart-total">
                <span>Total <span className="currency-label">SGD</span></span>
                <strong>{formatMoney(totalCents)}</strong>
              </div>
              <button className="submit-button" type="submit" disabled={submitting || !cartItems.length}>
                {submitting ? 'Submitting demo order…' : 'Submit demo order'}
                {!submitting && <span aria-hidden="true">→</span>}
              </button>
              <p className="submission-status" role="status">{submitting ? 'Your demo order is being submitted.' : ''}</p>
            </form>

            {orderError && (
              <div className="order-message error-message" role="alert">
                <p>{orderError}</p>
                <p>Your cart is unchanged.</p>
              </div>
            )}
            {confirmation && (
              <div className="order-message success-message" role="status">
                <h3>Demo order confirmed.</h3>
                <p>Total: <strong>{formatMoney(confirmation.totalCents)} SGD</strong></p>
                <p className="order-id">Order ID: {confirmation.id}</p>
              </div>
            )}

            <p className="demo-disclaimer">Demo only. No payment is collected and no real order is placed.</p>
          </aside>
        </div>
      </main>

      <footer className="site-footer">
        <span>KaiOrderApp</span>
        <span>A little ordering demo.</span>
      </footer>
    </div>
  );
}
