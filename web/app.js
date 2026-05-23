// DIAMOND:CONTEXT — the Board.
//
// Phase 3.0 starter: the design-system shell, rendered empty. The data
// fetch (MLB Stats API → game tiles with win expectancy) lands in the
// next commit.

const board = document.getElementById('board');

function renderEmpty(message, sub) {
    board.innerHTML = `
        <div class="empty">
            <p>${message}</p>
            ${sub ? `<p class="sub">${sub}</p>` : ''}
        </div>
    `;
}

renderEmpty(
    "The Board is waking up.",
    "Live game data wires in next · Phase 3.0",
);
