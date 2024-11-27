function formatDates() {
    const locale = navigator.language;
    
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

document.addEventListener('DOMContentLoaded', formatDates);
