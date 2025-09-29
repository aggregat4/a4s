# List Editing and Management Webapp Prototype

I want to create a web application prototype without a real backend to figure out some UI ideas.

These are the functional requirements:

- We want to manage Lists
- Lists have names
- Lists contain Items
- Items have a Title that we see and will be generally a small sentence to one paragraph in length
- Items have a Payload that is some arbitray text associated with it
- List items are ordered manually
- Item Titles can contain certain keywords that are single continuous words preceded by a '#' character or a '@' character
- Multiple Lists can be gathered in a Collection
- A List can be in multiple Collections
- We must be able to create and delete Collections, this does not affect the lists
- We need to be able to search in individual lists or inside a Collection
  - Results should be shown in their own dedicated UI
- It must be possible to quickly move List Items to other Lists: a keyboard shortcut pops up a dropdown where I can fuzzy find another List
  - It must be possible to bind the action of moving an Item to a dedicated List with a single shortcut
- It must be easy to reorder List Items with drag and drop
- It must be easy to start editing a List Title, optimally with no additional interactions aside from clicking in them

And the non-functional requirements:

- Vanilla JS, semantic HTML and modern (2025 baseline) CSS
- No frameworks
- No libraries unless it can not be sensibly avoided
- The whole UI must work on iOS and iPadOS: it should feel good on desktop as well, but we want to especially take care of making the dragging behaviour and editing behaviour be top notch on mobile

Things that are out of scope:

- We don't need a real backend, just create a bunch of hardcoded test lists and 2 or three collections with various combinations of Lists

