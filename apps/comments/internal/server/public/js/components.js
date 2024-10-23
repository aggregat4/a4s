/**
 * ActionConfirmation - This is a custom element that shows an inline confirmation UI before executing an action. Instead of being a modal
 * dialog it, the action button gets replaced with a cancel and confirm button in-place.
 * 
 * @attribute {string} actionName - The text to display on the action button.
 * @attribute {string} actionUrl - The URL to submit the form to when confirmed.
 * @attribute {string} [payloadName] - The name of the hidden input field for additional data, if specified then payloadContent
 *                                     must also be specified. The payload is optional.
 * @attribute {string} [payloadContent] - The value of the hidden payload input field.
 * @attribute {boolean} [directionLeftRight] - If true or omitted, places the cancel button to the left of the action button.
 *                                             If false, places the action button to the left.
 * 
 * @example
 * <action-confirmation 
 *   actionName="Delete" 
 *   actionUrl="/delete-item" 
 *   payloadName="itemId" 
 *   payloadContent="123" 
 *   directionLeftRight="false">
 * </action-confirmation>
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
    const directionLeftRight = (this.getAttribute('directionLeftRight') == null || this.getAttribute('directionLeftRight') === 'true');
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
        <button class="confirm">${actionName}...</button>` +
        ((payloadName && payloadContent) ? `<input type="hidden" name="${payloadName}" value="${payloadContent}"/>` : ``) +
        (directionLeftRight 
          ? `<button class="cancel hidden">Cancel</button><button class="action hidden">${actionName}!</button>` 
          : `<button class="action hidden">${actionName}!</button><button class="cancel hidden">Cancel</button>`) +
`      </form>`;
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
