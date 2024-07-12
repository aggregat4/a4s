/**
 * This is a custom element that shows an inline confirmation UI before executing an action. Instead of being a modal
 * dialog it, the action button gets replaced with a cancel and confirm button in the line you are.
 */
class ActionConfirmation extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
    this.addEventListeners();
  }

  disconnectedCallback() {
    this.removeEventListeners();
  }

  render() {
    const payloadName = this.getAttribute('payloadName');
    const payloadContent = this.getAttribute('payloadContent');
    const actionName = this.getAttribute('actionName');
    const actionUrl = this.getAttribute('actionUrl');

    this.shadowRoot.innerHTML = `
      <style>
        .hidden { display: none; }
      </style>
      <button class="confirm">${actionName}...</button>
      <button class="cancel hidden">Cancel</button>
      <form class="action-form hidden" method="post" action="${actionUrl}">` +
        ((payloadName && payloadContent) ? `<input type="hidden" name="${payloadName}" value="${payloadContent}"/>` : ``) +
`        <button class="action">${actionName}!</button>
      </form>`;
  }

  #confirmListener = null;
  #cancelListener = null;

  addEventListeners() {
    const confirmButton = this.shadowRoot.querySelector('.confirm');
    const cancelButton = this.shadowRoot.querySelector('.cancel');
    const actionForm = this.shadowRoot.querySelector('.action-form');

    this.#confirmListener = () => {
      confirmButton.classList.add('hidden');
      cancelButton.classList.remove('hidden');
      actionForm.classList.remove('hidden');
    };
    confirmButton.addEventListener('click', this.#confirmListener);

    this.#cancelListener = () => {
      confirmButton.classList.remove('hidden');
      cancelButton.classList.add('hidden');
      actionForm.classList.add('hidden');
    };
    cancelButton.addEventListener('click', this.#cancelListener);
  }

  removeEventListeners() {
    if (this.#confirmListener != null) {
        const confirmButton = this.shadowRoot.querySelector('.confirm');
        confirmButton.removeEventListener('click', this.#confirmListenerlistener);
        this.#confirmListener = null;
    }
    if (this.#cancelListener != null) {
      const cancelButton = this.shadowRoot.querySelector('.cancel');
      cancelButton.removeEventListener('click', this.#cancelListenerlistener);
      this.#cancelListener = null;
    }
  }
}

customElements.define('action-confirmation', ActionConfirmation);
