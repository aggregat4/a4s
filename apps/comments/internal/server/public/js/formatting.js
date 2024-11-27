function formatDates() {
    // Get user's locale from browser
    const locale = navigator.language;
    
    // Find all time elements
    document.querySelectorAll('time').forEach(timeElement => {
        const dateStr = timeElement.getAttribute('datetime');
        const date = new Date(dateStr);
        
        // Format for display
        const displayFormat = new Intl.DateTimeFormat(locale, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',            
            hour: 'numeric',
            minute: 'numeric'
        });
        
        // Format for tooltip
        const tooltipFormat = new Intl.DateTimeFormat(locale, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            timeZoneName: 'long'
        });
        
        timeElement.textContent = displayFormat.format(date);
        timeElement.title = tooltipFormat.format(date);
    });
}

// Run when DOM is loaded
document.addEventListener('DOMContentLoaded', formatDates);
