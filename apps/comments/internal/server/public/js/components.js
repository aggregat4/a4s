/**
 * This is a custom element that shows an inline confirmation UI before executing an action. Instead of being a modal
 * dialog it, the action button gets replaced with a cancel and confirm button in-place.
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
    // We calculate the minimum width of the action button based on the action name length to make the form layout
    // We need this to make sure that when we click on the confirm button, the cursor is not accidentally over the actual action but always over cancel
    const actionNameNumChars = actionName.length;
    

    this.shadowRoot.innerHTML = `
      <style>
        .hidden { display: none; }
        .action-form {
          display: flex;
          gap: 1rem;
          flex-direction: row;
          background-color: #d5d5d5;
          padding: 4px;
          border-radius: 3px;
        }
        button {
          min-width: ${actionNameNumChars}em;
        }
      </style>
      <form class="action-form" method="post" action="${actionUrl}">
        <button class="confirm">${actionName}...</button>
        <button class="cancel hidden">Cancel</button>` +
        ((payloadName && payloadContent) ? `<input type="hidden" name="${payloadName}" value="${payloadContent}"/>` : ``) +
`       <button class="action hidden">${actionName}!</button>
      </form>`;
  }

  #confirmListener = null;
  #cancelListener = null;

  addEventListeners() {
    const confirmButton = this.shadowRoot.querySelector('.confirm');
    const cancelButton = this.shadowRoot.querySelector('.cancel');
    const actionButton = this.shadowRoot.querySelector('.action');

    this.#confirmListener = (e) => {
      e.preventDefault();
      confirmButton.classList.add('hidden');
      cancelButton.classList.remove('hidden');
      actionButton.classList.remove('hidden');
    };
    confirmButton.addEventListener('click', this.#confirmListener);

    this.#cancelListener = (e) => {
      e.preventDefault();
      confirmButton.classList.remove('hidden');
      cancelButton.classList.add('hidden');
      actionButton.classList.add('hidden');
    };
    cancelButton.addEventListener('click', this.#cancelListener);
  }

  removeEventListeners() {
    if (this.#confirmListener != null) {
      const confirmButton = this.shadowRoot.querySelector('.confirm');
      confirmButton.removeEventListener('click', this.#confirmListener);
      this.#confirmListener = null;
    }
    if (this.#cancelListener != null) {
      const cancelButton = this.shadowRoot.querySelector('.cancel');
      cancelButton.removeEventListener('click', this.#cancelListener);
      this.#cancelListener = null;
    }
  }
}

customElements.define('action-confirmation', ActionConfirmation);
